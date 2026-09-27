import { AIChatAgent } from "@cloudflare/ai-chat";
import { callable, type Connection } from "agents";
import { convertToModelMessages, isStepCount, pruneMessages, streamText, tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { billingEnabled, dailyLimit, planFor, type Usage } from "./billing";
import * as ops from "./shared";
import { THEME_IDS, type Attachment, type Board } from "./shared";
import { systemPrompt } from "./prompt";
import { CardIndex } from "./search";
import { BOARD_TOOLS, describeHits, SEARCH_TOOL, TOOL_NAMES, type SearchResult, type ToolName, type ToolOutcome } from "./tools";

const HISTORY_LIMIT = 30;
// Removed attachments stay in R2 while undo could bring them back. Cleanup runs a
// day after something drops one, and checks again weekly while history still does.
const ATTACHMENT_GRACE_S = 25 * 60 * 60;
const ATTACHMENT_RECHECK_S = 7 * 24 * 60 * 60;

/**
 * One instance per signed-in user (named by their user id). Holds the board as
 * synced agent state, the chat transcript, and an undo stack in SQLite.
 * Clients can't write state directly; every change goes through a callable or
 * one of the board tools (tools.ts), both of which use the ops in shared.ts.
 * The tools are reached from the in-app chat and, over RPC, from the MCP endpoint.
 */
export class TodoAgent extends AIChatAgent<Env, Board> {
  initialState = ops.newBoard();
  maxPersistedMessages = 120;
  messageConcurrency = "queue" as const;

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, grp TEXT, label TEXT, board TEXT NOT NULL)`;
    // Boards that were undone, newest last, so an accidental undo can be redone.
    // Any new change clears it, the same as in an editor.
    this.sql`CREATE TABLE IF NOT EXISTS redo (
      id INTEGER PRIMARY KEY AUTOINCREMENT, grp TEXT, label TEXT, board TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, chats INTEGER NOT NULL)`;
    this.index.backfill(this.state);
  }

  // Keyword and semantic search over this board (search.ts).
  private _index?: CardIndex;
  private get index(): CardIndex {
    if (!this._index) {
      this._index = new CardIndex(this.ctx.storage.sql, this.env.AI, this.env.EMBEDDING_MODEL);
      this._index.init();
    }
    return this._index;
  }

  /** Keep the search index in step with a board change. Embeddings update in the background. */
  private reindex(before: Board | null, after: Board) {
    this.index.sync(before, after);
    this.index.refreshVectors(after).catch((e) => console.warn("embedding refresh failed", (e as Error).message));
  }

  /** Search titles and notes. For the UI (callable), the assistant, and MCP (RPC). */
  @callable()
  async search(input: unknown): Promise<SearchResult> {
    return this.index.search(this.state, SEARCH_TOOL.inputSchema.parse(input));
  }

  validateStateChange(_next: Board, source: Connection | "server") {
    if (source !== "server") throw new Error("Use the board actions to change the board");
  }

  /**
   * Apply a change and remember the previous board for undo. Changes that share
   * a `group` (every tool call in one chat turn) collapse into one undo step.
   */
  private mutate(label: string, fn: (b: Board) => Board, group?: string): Board {
    const before = this.state;
    const after = fn(before);
    const top = this.sql<{ grp: string | null }>`SELECT grp FROM history ORDER BY id DESC LIMIT 1`[0];
    if (!group || top?.grp !== group) {
      this.sql`INSERT INTO history (grp, label, board) VALUES (${group ?? null}, ${label}, ${JSON.stringify(before)})`;
      this.sql`DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT ${HISTORY_LIMIT})`;
    }
    this.sql`DELETE FROM redo`;
    this.setState(after);
    this.reindex(before, after);
    const kept = new Set(ops.attachmentIds(after));
    if (ops.attachmentIds(before).some((id) => !kept.has(id))) void this.scheduleCleanup(ATTACHMENT_GRACE_S);
    return after;
  }

  // ---------- attachments ----------

  private scheduleCleanup(delayS: number) {
    // One pending run is enough; later drops are covered by it or by its recheck.
    if (this.getSchedules().some((s) => s.callback === "collectAttachments")) return;
    return this.schedule(delayS, "collectAttachments");
  }

  /**
   * Record a file the Worker just stored in R2. Deliberately not @callable: only
   * the upload endpoint may add one, after it has checked the size and quota.
   */
  attach(cardId: string, att: Attachment): { ok: true } | { ok: false; error: string } {
    try {
      this.mutate("Attach file", (b) => ops.addAttachment(b, cardId, att));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  @callable()
  removeAttachment(cardId: string, attId: string) {
    this.mutate("Remove attachment", (b) => ops.removeAttachment(b, cardId, attId));
  }

  /** Delete R2 objects that neither the board nor undo history refers to. */
  async collectAttachments() {
    const live = new Set(ops.attachmentIds(this.state));
    const inHistory = new Set<string>();
    for (const row of this.sql<{ board: string }>`SELECT board FROM history UNION ALL SELECT board FROM redo`) {
      for (const id of ops.attachmentIds(JSON.parse(row.board) as Board)) if (!live.has(id)) inHistory.add(id);
    }
    const prefix = `${this.name}/`;
    const doomed: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.env.ATTACHMENTS.list({ prefix, cursor });
      for (const obj of page.objects) {
        const id = obj.key.slice(prefix.length);
        // Skip very new objects: an upload may be between R2 and the board.
        if (!live.has(id) && !inHistory.has(id) && Date.now() - obj.uploaded.getTime() > 60 * 60 * 1000) doomed.push(obj.key);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    for (let i = 0; i < doomed.length; i += 1000) await this.env.ATTACHMENTS.delete(doomed.slice(i, i + 1000));
    if (inHistory.size) await this.schedule(ATTACHMENT_RECHECK_S, "collectAttachments");
  }

  // ---------- board actions for the UI ----------

  @callable()
  addCard(laneId: string, title: string, top = false) {
    let id = "";
    this.mutate("Add card", (b) => {
      const r = ops.addCard(b, { title, laneId, top });
      id = r.card.id;
      return r.board;
    });
    return id;
  }

  @callable()
  updateCard(id: string, patch: { title?: string; notes?: string; due?: string | null }) {
    this.mutate("Edit card", (b) => ops.updateCard(b, id, patch));
  }

  @callable()
  moveCard(id: string, laneId: string, index: number) {
    this.mutate("Move card", (b) => ops.moveCard(b, id, laneId, index));
  }

  @callable()
  deleteCard(id: string) {
    this.mutate("Delete card", (b) => ops.deleteCards(b, [id]));
  }

  @callable()
  addLane(name: string) {
    this.mutate("Add lane", (b) => ops.addLane(b, name).board);
  }

  @callable()
  renameLane(id: string, name: string) {
    this.mutate("Rename lane", (b) => ops.renameLane(b, id, name));
  }

  @callable()
  deleteLane(id: string) {
    this.mutate("Delete lane", (b) => ops.deleteLane(b, id));
  }

  @callable()
  moveLane(id: string, index: number) {
    this.mutate("Move lane", (b) => ops.moveLane(b, id, index));
  }

  @callable()
  clearLane(id: string) {
    this.mutate("Clear lane", (b) => ops.deleteCards(b, ops.laneCards(b, id).map((c) => c.id)));
  }

  @callable()
  setTheme(theme: string) {
    if (!(THEME_IDS as readonly string[]).includes(theme)) throw new Error(`Unknown theme ${theme}`);
    this.setState({ ...this.state, theme, themeChosen: true }); // preferences aren't undoable
  }

  /** Swap in a board from the undo or redo stack, keeping preferences, which aren't undoable. */
  private restore(board: Board) {
    const before = this.state;
    this.setState({ ...board, theme: before.theme, themeChosen: before.themeChosen });
    this.reindex(before, this.state);
    const kept = new Set(ops.attachmentIds(this.state));
    if (ops.attachmentIds(before).some((id) => !kept.has(id))) void this.scheduleCleanup(ATTACHMENT_GRACE_S);
  }

  /** Undo the last change. Returns what was undone, or null when there's nothing left. */
  @callable()
  undo(): string | null {
    const top = this.sql<{ id: number; label: string; board: string }>`
      SELECT id, label, board FROM history ORDER BY id DESC LIMIT 1`[0];
    if (!top) return null;
    this.sql`DELETE FROM history WHERE id = ${top.id}`;
    this.sql`INSERT INTO redo (grp, label, board) VALUES (NULL, ${top.label}, ${JSON.stringify(this.state)})`;
    this.sql`DELETE FROM redo WHERE id NOT IN (SELECT id FROM redo ORDER BY id DESC LIMIT ${HISTORY_LIMIT})`;
    this.restore(JSON.parse(top.board) as Board);
    return top.label;
  }

  /** Redo the last undone change. Returns what was redone, or null when there's nothing to redo. */
  @callable()
  redo(): string | null {
    const top = this.sql<{ id: number; label: string; board: string }>`
      SELECT id, label, board FROM redo ORDER BY id DESC LIMIT 1`[0];
    if (!top) return null;
    this.sql`DELETE FROM redo WHERE id = ${top.id}`;
    this.sql`INSERT INTO history (grp, label, board) VALUES (NULL, ${top.label}, ${JSON.stringify(this.state)})`;
    this.restore(JSON.parse(top.board) as Board);
    return top.label;
  }

  /** Labels for the Undo and Redo buttons, or null when that stack is empty. */
  @callable()
  undoRedo(): { undo: string | null; redo: string | null } {
    return {
      undo: this.sql<{ label: string }>`SELECT label FROM history ORDER BY id DESC LIMIT 1`[0]?.label ?? null,
      redo: this.sql<{ label: string }>`SELECT label FROM redo ORDER BY id DESC LIMIT 1`[0]?.label ?? null,
    };
  }

  // ---------- board tools, for the chat below and for outside agents (mcp.ts) ----------

  /**
   * Run one board tool. Calls sharing a `group` collapse into one undo step, so a
   * whole chat turn undoes at once; each MCP call is its own step.
   */
  runTool(name: ToolName, input: unknown, group?: string): ToolOutcome {
    const t = BOARD_TOOLS[name];
    if (!t) return { ok: false, summary: `Unknown tool ${name}` };
    try {
      const args = t.inputSchema.parse(input);
      let summary = "";
      const board = this.mutate(t.label, (b) => {
        const r = (t.apply as (b: Board, i: typeof args) => { board: Board; summary: string })(b, args);
        summary = r.summary;
        return r.board;
      }, group);
      return { ok: true, summary, board: ops.describeBoard(board) };
    } catch (e) {
      return { ok: false, summary: (e as Error).message };
    }
  }

  /** The board as plain text, the same view the chat model gets. */
  describe(): string {
    return ops.describeBoard(this.state);
  }

  /**
   * A turn the tab handled itself with the local model (Needle 3, see src/needle-tools.ts):
   * run the resolved board tools as one undo step and write the same user and assistant
   * messages the big-model path would, so the sidebar, undo, and every open tab agree.
   * Local turns are free, so they don't count against the daily cap.
   */
  @callable()
  async applyLocal(turn: { text: string; calls: { name: ToolName; input: unknown }[]; engine: string; confidence: number; ms?: number }): Promise<{ outcomes: ToolOutcome[]; reply: string }> {
    const text = String(turn.text ?? "").trim().slice(0, 2000);
    const calls = Array.isArray(turn.calls) ? turn.calls.slice(0, 8) : [];
    if (!text || !calls.length) throw new Error("Nothing to apply.");
    const group = crypto.randomUUID();
    const outcomes = calls.map((c) => this.runTool(c.name, c.input, group));
    const done = outcomes.filter((o) => o.ok).map((o) => o.summary);
    const reply = done.length ? `${done.join(". ")}.` : "That didn't work; try telling me again.";
    const stamp = new Date().toISOString();
    const user = { id: crypto.randomUUID(), role: "user" as const, parts: [{ type: "text" as const, text }], metadata: { createdAt: stamp } };
    const assistant = {
      id: crypto.randomUUID(),
      role: "assistant" as const,
      metadata: { createdAt: stamp, local: true, engine: turn.engine, confidence: turn.confidence, ms: turn.ms ?? null },
      parts: [
        ...calls.map((c, i) => ({ type: `tool-${c.name}` as const, toolCallId: `local-${group}-${i}`, state: "output-available" as const, input: c.input, output: outcomes[i] })),
        { type: "text" as const, text: reply, state: "done" as const },
      ],
    };
    await this.persistMessages([...this.messages, user, assistant] as typeof this.messages);
    return { outcomes, reply };
  }

  // ---------- chat agent ----------

  private today = () => new Date().toISOString().slice(0, 10);

  /** Assistant messages used today, the cap for this user's plan, and whether they can upgrade. */
  @callable()
  async usage(): Promise<Usage> {
    const plan = await planFor(this.env, this.name);
    const used = this.sql<{ chats: number }>`SELECT chats FROM usage WHERE day = ${this.today()}`[0]?.chats ?? 0;
    return { plan, used, limit: dailyLimit(this.env, plan), billing: billingEnabled(this.env) };
  }

  async onChatMessage(_onFinish: unknown, options?: { requestId: string; abortSignal?: AbortSignal; body?: Record<string, unknown> }) {
    const day = this.today();
    const { plan, used, limit, billing } = await this.usage();
    if (used >= limit) {
      const more = plan === "free" && billing ? " Upgrade to Pro for more, or try" : " Try";
      return new Response(`You've used today's ${limit} assistant messages. The board still works.${more} again tomorrow (UTC).`, { status: 429 });
    }
    this.sql`INSERT INTO usage (day, chats) VALUES (${day}, 1)
      ON CONFLICT(day) DO UPDATE SET chats = chats + 1`;

    const group = options?.requestId ?? crypto.randomUUID();
    const tz = typeof options?.body?.timezone === "string" ? options.body.timezone : "UTC";
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz, weekday: "long", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

    const workersai = createWorkersAI({ binding: this.env.AI });
    const result = streamText({
      model: workersai(this.env.CHAT_MODEL as Parameters<typeof workersai>[0]),
      abortSignal: options?.abortSignal,
      system: systemPrompt(this.state, today),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        reasoning: "all",
        toolCalls: "before-last-2-messages",
      }),
      stopWhen: isStepCount(8),
      tools: {
        ...Object.fromEntries(TOOL_NAMES.map((name) => {
          const { description, inputSchema } = BOARD_TOOLS[name];
          return [name, tool({ description, inputSchema, execute: async (input: unknown) => this.runTool(name, input, group) })];
        })),
        [SEARCH_TOOL.name]: tool({
          description: SEARCH_TOOL.description,
          inputSchema: SEARCH_TOOL.inputSchema,
          execute: async (input) => {
            try {
              const r = await this.search(input);
              return { ok: true, summary: `Searched "${input.query}": ${r.hits.length} found`, results: describeHits(r) };
            } catch (e) {
              return { ok: false, summary: (e as Error).message };
            }
          },
        }),
      },
    });

    return result.toUIMessageStreamResponse();
  }
}
