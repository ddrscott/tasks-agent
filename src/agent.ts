import { AIChatAgent } from "@cloudflare/ai-chat";
import { callable, type Connection } from "agents";
import { convertToModelMessages, isStepCount, pruneMessages, streamText, tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { billingEnabled, dailyLimit, planFor, type Usage } from "./billing";
import * as ops from "./shared";
import { THEME_IDS, type Board } from "./shared";
import { BOARD_TOOLS, TOOL_NAMES, type ToolName, type ToolOutcome } from "./tools";

const HISTORY_LIMIT = 30;

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
    this.sql`CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, chats INTEGER NOT NULL)`;
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
    this.setState(after);
    return after;
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
    this.setState({ ...this.state, theme }); // preferences aren't undoable
  }

  /** Undo the last change. Returns what was undone, or null when there's nothing left. */
  @callable()
  undo(): string | null {
    const top = this.sql<{ id: number; label: string; board: string }>`
      SELECT id, label, board FROM history ORDER BY id DESC LIMIT 1`[0];
    if (!top) return null;
    this.sql`DELETE FROM history WHERE id = ${top.id}`;
    const restored = JSON.parse(top.board) as Board;
    this.setState({ ...restored, theme: this.state.theme });
    return top.label;
  }

  @callable()
  canUndo(): string | null {
    return this.sql<{ label: string }>`SELECT label FROM history ORDER BY id DESC LIMIT 1`[0]?.label ?? null;
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
      tools: Object.fromEntries(TOOL_NAMES.map((name) => {
        const { description, inputSchema } = BOARD_TOOLS[name];
        return [name, tool({ description, inputSchema, execute: async (input: unknown) => this.runTool(name, input, group) })];
      })),
    });

    return result.toUIMessageStreamResponse();
  }
}

function systemPrompt(board: Board, today: string): string {
  return `You are the assistant built into Tasks, a kanban-style task board. The user chats with you to
add, update, move, and remove their cards. The board is on screen next to this chat and
updates live when you use a tool.

Today is ${today}.

Current board:
${ops.describeBoard(board)}

How to work:
- Act with the tools; don't just describe what you would do. Batch related changes into one
  call where the tool allows it (add several cards at once, move several ids at once).
- Decide each card's final lane before calling a tool, and move each card once. Only touch
  the cards the user actually mentioned.
- Match what the user says to existing cards by meaning, not exact wording. If two cards
  could match and it matters, ask which one.
- "Done", "finished", "did", "got" usually means move the card to the last lane (the done lane).
  "Started" or "working on" means the middle lane.
- Turn relative dates ("friday", "next week") into YYYY-MM-DD using today's date.
- Everything you change can be undone with one click, so act without asking for confirmation,
  except delete_lane, which also deletes its cards.
- After acting, reply in one short sentence. Never mention card ids, lane ids, or tool names.
- If the user asks something unrelated to their board, answer briefly and helpfully.`;
}
