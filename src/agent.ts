import { AIChatAgent } from "@cloudflare/ai-chat";
import { callable, type Connection } from "agents";
import { convertToModelMessages, isStepCount, pruneMessages, streamText, tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { billingEnabled, dailyLimit, planFor, type Usage } from "./billing";
import * as ops from "./shared";
import { isSealed, NEEDS_CEO_TAG, THEME_IDS, type Attachment, type Board, type Card, type SealInfo } from "./shared";
import { ENVELOPE_ALG, kidOf, proofHash } from "./sealed";
import { systemPrompt } from "./prompt";
import { agentEvents, agentQueue, type TaskEvent } from "./events";
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
/** Who made a change: you (the app, its assistant) or an outside agent over MCP. */
type Actor = "you" | "agent";

export class TodoAgent extends AIChatAgent<Env, Board> {
  initialState = ops.newBoard();
  maxPersistedMessages = 120;
  messageConcurrency = "queue" as const;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // AIChatAgent handles chat frames in the onMessage it installs in its own constructor, and
    // stores whatever messages the client sends before any hook runs. On an encrypted board,
    // stop those frames here, before the SDK sees them. The browser never sends them there:
    // local turns go through applyLocal, which builds the transcript on the server.
    const inner = this.onMessage.bind(this);
    this.onMessage = (connection, message) => {
      if (this.state?.sealed && typeof message === "string") {
        const frame = chatFrame(message);
        if (frame && CHAT_FRAMES_BLOCKED_WHEN_SEALED.has(frame.type)) {
          if (frame.type === "cf_agent_use_chat_request") {
            connection.send(JSON.stringify({ type: "cf_agent_use_chat_response", id: frame.id, body: SEALED_NOTICE, done: true, error: true }));
          }
          return;
        }
      }
      return inner(connection, message);
    };
  }

  /** Message arrays built on the server (applyLocal), the only ones an encrypted board accepts whole. */
  private trusted = new WeakSet<object>();

  /**
   * On an encrypted board, keep only messages the server built or already has, byte for byte.
   * Everything a client could slip in (a chat frame the gate above missed, a tool result) is
   * dropped, so nothing unencrypted reaches the transcript by any path.
   */
  override async persistMessages(...args: Parameters<AIChatAgent<Env, Board>["persistMessages"]>) {
    const [messages, exclude, options] = args;
    if (!this.state.sealed || this.trusted.has(messages)) return super.persistMessages(messages, exclude, options);
    const prior = new Map(this.messages.map((m) => [m.id, JSON.stringify(m)]));
    const kept = messages.filter((m) => prior.get(m.id) === JSON.stringify(m));
    // A dropped message mustn't also delete the stored ones it didn't list.
    const opts = kept.length === messages.length ? options : { ...options, _deleteStaleRows: false };
    return super.persistMessages(kept, exclude, opts);
  }

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS seal_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, grp TEXT, label TEXT, board TEXT NOT NULL)`;
    // Boards that were undone, newest last, so an accidental undo can be redone.
    // Any new change clears it, the same as in an editor.
    this.sql`CREATE TABLE IF NOT EXISTS redo (
      id INTEGER PRIMARY KEY AUTOINCREMENT, grp TEXT, label TEXT, board TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, chats INTEGER NOT NULL)`;
    if (!this.state.sealed) this.index.backfill(this.state);
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
    if (after.sealed) return; // the server can't read an encrypted board, so it can't index one
    this.index.sync(before, after);
    this.index.refreshVectors(after).catch((e) => console.warn("embedding refresh failed", (e as Error).message));
  }

  /** Search titles and notes. For the UI (callable), the assistant, and MCP (RPC). */
  @callable()
  async search(input: unknown): Promise<SearchResult> {
    if (this.state.sealed) throw new Error("This board is end-to-end encrypted, so only the app can search it, in your browser.");
    return this.index.search(this.state, SEARCH_TOOL.inputSchema.parse(input));
  }

  validateStateChange(_next: Board, source: Connection | "server") {
    if (source !== "server") throw new Error("Use the board actions to change the board");
  }

  /**
   * Apply a change and remember the previous board for undo. Changes that share
   * a `group` (every tool call in one chat turn) collapse into one undo step.
   */
  private mutate(label: string, fn: (b: Board) => Board, group?: string, actor: Actor = "you"): Board {
    const before = this.state;
    const after = fn(before);
    ops.assertSealedBoard(after);
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
    if (actor === "you") this.publish(agentEvents(before, after));
    return after;
  }

  /** Tell any listening agent session (events.ts) about changes you made to #agent cards. */
  private publish(events: TaskEvent[]) {
    if (!events.length) return;
    const feed = this.env.TaskEvents.get(this.env.TaskEvents.idFromName(this.name));
    this.ctx.waitUntil(feed.publish(events).catch((e: Error) => console.warn("event publish failed", e.message)));
  }

  /** The open #agent cards, sent to an event client when it connects. Null on an encrypted board. */
  agentQueue(): TaskEvent | null {
    return this.state.sealed ? null : agentQueue(this.state);
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
  updateCard(id: string, patch: { title?: string; notes?: string; due?: string | null; tags?: string[] }) {
    this.mutate("Edit card", (b) => ops.updateCard(b, id, patch));
  }

  /** Answer the question on a card (ask_ceo): one of its options by index, or typed text. */
  @callable()
  answerAsk(id: string, input: { choice?: number; text?: string }) {
    this.mutate("Answer question", (b) => ops.answerAsk(b, id, input ?? {}));
  }

  /** An outside agent putting a question on a card, over MCP (mcp.ts). Not callable from the browser. */
  askCeo(input: { id: string; question: string; options: string[]; recommended?: number }): ToolOutcome {
    try {
      const board = this.mutate("Agent asked a question", (b) => ops.askCard(b, input.id, input), undefined, "agent");
      const card = board.cards.find((c) => c.id === input.id)!;
      return { ok: true, summary: `Asked on "${card.title}" [${card.id}]: ${card.ask!.question}`, board: ops.describeBoard(board, NEEDS_CEO_TAG) };
    } catch (e) {
      return { ok: false, summary: (e as Error).message };
    }
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

  /** Reorder a lane to the order the browser sorted it into (shared.ts, sortedIds). */
  @callable()
  sortLane(id: string, ids: string[]) {
    this.mutate("Sort lane", (b) => ops.orderLane(b, id, ids));
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
    // The passphrase envelope isn't undoable either: an undo must never bring back an old passphrase.
    this.setState({ ...board, theme: before.theme, themeChosen: before.themeChosen, sealed: before.sealed });
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
   * whole chat turn undoes at once; each MCP call is its own step. MCP passes
   * actor "agent", so an outside agent's own changes don't come back to it as events.
   */
  runTool(name: ToolName, input: unknown, group?: string, actor: Actor = "you"): ToolOutcome {
    const t = BOARD_TOOLS[name];
    if (!t) return { ok: false, summary: `Unknown tool ${name}` };
    try {
      const args = t.inputSchema.parse(input);
      let summary = "";
      const board = this.mutate(t.label, (b) => {
        const r = (t.apply as (b: Board, i: typeof args) => { board: Board; summary: string })(b, args);
        summary = r.summary;
        return r.board;
      }, group, actor);
      return { ok: true, summary, board: ops.describeBoard(board) };
    } catch (e) {
      return { ok: false, summary: (e as Error).message };
    }
  }

  /** Whether the board is end-to-end encrypted, for MCP. */
  isSealed(): boolean {
    return !!this.state.sealed;
  }

  /** A card's title, for the claim tools (mcp.ts). Null when there's no such card or the board is encrypted. */
  cardTitle(id: string): string | null {
    if (this.state.sealed) return null;
    return this.state.cards.find((c) => c.id === id)?.title ?? null;
  }

  /** The board as plain text, the same view the chat model gets. */
  describe(tag?: string): string {
    if (this.state.sealed) return SEALED_NOTICE;
    return ops.describeBoard(this.state, tag ? ops.cleanTag(tag) : undefined);
  }

  /**
   * A turn the tab handled itself with the local model (Needle 3, see src/needle-tools.ts):
   * run the resolved board tools as one undo step and write the same user and assistant
   * messages the big-model path would, so the sidebar, undo, and every open tab agree.
   * Local turns are free, so they don't count against the daily cap.
   */
  @callable()
  async applyLocal(turn: { text: string; calls: { name: ToolName; input: unknown }[]; engine: string; confidence: number; ms?: number }): Promise<{ outcomes: ToolOutcome[]; reply: string }> {
    const sealed = this.state.sealed;
    const text = sealed ? String(turn.text ?? "") : String(turn.text ?? "").trim().slice(0, 2000);
    // On an encrypted board the transcript is stored too, so the message has to arrive encrypted.
    if (sealed && !(isSealed(text) && kidOf(text) === sealed.kid)) throw new Error("This board is encrypted; the message has to be too.");
    const raw = Array.isArray(turn.calls) ? turn.calls.slice(0, 8) : [];
    if (!text || !raw.length) throw new Error("Nothing to apply.");
    // The inputs are stored in the transcript as well, so on an encrypted board they have to be
    // clean before anything runs: parsed by the tool's schema (unknown keys dropped), with every
    // string either an id already on the board or ciphertext under the board's key.
    const calls = sealed ? this.sealedCalls(raw, sealed.kid) : raw;
    const group = crypto.randomUUID();
    const outcomes = calls.map((c) => this.runTool(c.name, c.input, group));
    const done = outcomes.filter((o) => o.ok).map((o) => o.summary);
    const reply = done.length ? `${done.join(". ")}.` : "That didn't work; try telling me again.";
    const stamp = new Date().toISOString();
    const user = { id: crypto.randomUUID(), role: "user" as const, parts: [{ type: "text" as const, text }], metadata: { createdAt: stamp } };
    const assistant = {
      id: crypto.randomUUID(),
      role: "assistant" as const,
      metadata: { createdAt: stamp, local: true, engine: turn.engine === "needle-rs" ? "needle-rs" : "local", confidence: clamp01(turn.confidence), ms: finiteOrNull(turn.ms) },
      parts: [
        ...calls.map((c, i) => ({
          type: `tool-${c.name}` as const, toolCallId: `local-${group}-${i}`, state: "output-available" as const,
          // A call that failed didn't change anything, so there's no reason to keep what it was sent.
          input: sealed && !outcomes[i].ok ? {} : c.input, output: outcomes[i],
        })),
        { type: "text" as const, text: reply, state: "done" as const },
      ],
    };
    const next = [...this.messages, user, assistant] as typeof this.messages;
    this.trusted.add(next);
    await this.persistMessages(next);
    return { outcomes, reply };
  }

  /** Validate a local turn's tool calls for an encrypted board. Throws on anything that could be plaintext. */
  private sealedCalls(calls: { name: ToolName; input: unknown }[], kid: string): { name: ToolName; input: unknown }[] {
    const ids = new Set([...this.state.cards.map((c) => c.id), ...this.state.lanes.map((l) => l.id)]);
    const clean = (v: unknown): boolean =>
      typeof v === "string" ? ids.has(v) || (isSealed(v) && kidOf(v) === kid)
        : Array.isArray(v) ? v.every(clean)
        : v !== null && typeof v === "object" ? Object.values(v).every(clean)
        : v === null || typeof v === "number" || typeof v === "boolean" || v === undefined;
    return calls.map((c) => {
      const t = BOARD_TOOLS[c.name];
      if (!t) throw new Error(`Unknown tool ${String(c.name)}.`);
      const parsed = t.inputSchema.safeParse(c.input);
      if (!parsed.success || !clean(parsed.data)) throw new Error("This board is encrypted; a tool call carried text that wasn't.");
      return { name: c.name, input: parsed.data };
    });
  }

  // ---------- end-to-end encryption (sealed.ts) ----------
  //
  // The browser encrypts or decrypts the whole board and hands it back. The server checks
  // that it's the same board (same lanes and cards, by id), that every field is ciphertext
  // (or, turning it off, plaintext), then swaps it in and erases everything that held the
  // old form: undo and redo history, the chat transcript, the search index, and the old
  // attachment files in R2.

  @callable()
  async enableEncryption(input: { kid: string; envelope: string; board: Board; proof: string }) {
    if (this.state.sealed) throw new Error("This board is already encrypted.");
    const seal = checkEnvelope(input?.kid, input?.envelope);
    const check = await proofHash(checkProof(input?.proof));
    const next = await this.adopt(input?.board, seal);
    ops.assertSealedBoard(next);
    await this.swapBoard(next);
    this.sql`INSERT OR REPLACE INTO seal_meta (k, v) VALUES ('check', ${check})`;
    // An encrypted board keeps no session presence or claims (presence.ts): erase what's there.
    await this.env.Presence.get(this.env.Presence.idFromName(this.name)).wipe()
      .catch((e: Error) => console.warn("presence wipe failed", e.message));
  }

  /**
   * Boards encrypted before the key check existed get one from the first unlocked tab.
   * Returns whether the proof matches the stored check.
   */
  @callable()
  async ensureKeyCheck(proof: string): Promise<boolean> {
    if (!this.state.sealed) return false;
    const hash = await proofHash(checkProof(proof));
    const have = this.metaValue("check");
    if (!have) this.sql`INSERT INTO seal_meta (k, v) VALUES ('check', ${hash})`;
    return !have || have === hash;
  }

  /**
   * Turning encryption off re-uploads every file unencrypted before the board swaps. Those
   * uploads are refused on an encrypted board unless this opened a window for them, which
   * takes proof of the key.
   */
  @callable()
  async beginDisable(input: { proof: string }) {
    if (!this.state.sealed) throw new Error("This board isn't encrypted.");
    await this.requireProof(input?.proof);
    this.sql`INSERT OR REPLACE INTO seal_meta (k, v) VALUES ('plain_staging_until', ${String(Date.now() + 15 * 60 * 1000)})`;
  }

  @callable()
  async disableEncryption(input: { board: Board; proof: string }) {
    if (!this.state.sealed) throw new Error("This board isn't encrypted.");
    await this.requireProof(input?.proof);
    const next = await this.adopt(input?.board, undefined);
    if (ops.boardTexts(next).some(isSealed)) throw new Error("Some of the board is still encrypted.");
    await this.swapBoard(next);
    this.sql`DELETE FROM seal_meta`;
    this.index.clear();
    this.index.sync(null, next);
    this.index.refreshVectors(next).catch((e) => console.warn("embedding refresh failed", (e as Error).message));
  }

  /** A new envelope for the same key, under a new passphrase. `previous` guards against two tabs racing. */
  @callable()
  async changePassphrase(input: { previous: string; envelope: string; proof: string }) {
    const seal = this.state.sealed;
    if (!seal) throw new Error("This board isn't encrypted.");
    await this.requireProof(input?.proof);
    if (input?.previous !== seal.envelope) throw new Error("The passphrase was changed somewhere else. Reload and try again.");
    const next = checkEnvelope(seal.kid, input.envelope);
    this.setState({ ...this.state, sealed: { ...seal, envelope: next.envelope } });
  }

  /** For a forgotten passphrase: throw the encrypted board away and start over with an empty, unencrypted one. */
  @callable()
  async resetEncryptedBoard() {
    if (!this.state.sealed) throw new Error("This board isn't encrypted.");
    await this.swapBoard({ ...ops.newBoard(), theme: this.state.theme, themeChosen: this.state.themeChosen });
    this.sql`DELETE FROM seal_meta`;
    this.index.clear();
  }

  /** What the upload endpoint may accept: files encrypted under `kid`, and plain ones only while turning encryption off. */
  uploadPolicy(): { kid: string | null; plainStaging: boolean } {
    const kid = this.state.sealed?.kid ?? null;
    return { kid, plainStaging: !!kid && Number(this.metaValue("plain_staging_until") ?? 0) > Date.now() };
  }

  /** A staged upload that never makes it onto the board is collected with the other orphans. */
  noteStaged() {
    void this.scheduleCleanup(ATTACHMENT_GRACE_S);
  }

  private metaValue(k: string): string | undefined {
    return this.sql<{ v: string }>`SELECT v FROM seal_meta WHERE k = ${k}`[0]?.v;
  }

  private async requireProof(proof: unknown) {
    const have = this.metaValue("check");
    if (!have) throw new Error("This board has no key check yet. Unlock it in the app first.");
    if ((await proofHash(checkProof(proof))) !== have) throw new Error("That isn't this board's key.");
  }

  /**
   * Rebuild a board the client sent from known fields only, and check it against the live one.
   * Timestamps come from the live board; attachment sizes come from R2.
   */
  private async adopt(raw: Board | undefined, seal: SealInfo | undefined): Promise<Board> {
    const cur = this.state;
    if (!raw || !Array.isArray(raw.lanes) || !Array.isArray(raw.cards)) throw new Error("That isn't a board.");
    if (!ops.sameShape(cur, raw)) throw new Error("The board changed while this was running. Try again.");
    const live = new Map(cur.cards.map((c) => [c.id, c]));
    const wantSealed = !!seal;
    const cards: Card[] = [];
    for (const c of raw.cards) {
      const was = live.get(c.id)!;
      const attachments: Attachment[] = [];
      for (const a of c.attachments ?? []) {
        if (!/^a[0-9a-f]{16}$/.test(a.id)) throw new Error("Bad attachment id.");
        const obj = await this.env.ATTACHMENTS.head(`${this.name}/${a.id}`);
        if (!obj) throw new Error("An attachment didn't finish uploading. Try again.");
        if ((obj.customMetadata?.sealed === "1") !== wantSealed) throw new Error("An attachment is in the wrong form. Try again.");
        attachments.push({ id: a.id, name: String(a.name), type: String(a.type), size: obj.size, addedAt: String(a.addedAt ?? was.createdAt) });
      }
      const tags = Array.isArray(c.tags) ? c.tags.map(String) : [];
      if (tags.length > ops.MAX_TAGS_PER_CARD) throw new Error(`A card can have ${ops.MAX_TAGS_PER_CARD} tags`);
      cards.push({
        id: c.id, laneId: c.laneId, title: String(c.title), notes: String(c.notes ?? ""), due: c.due == null ? null : String(c.due),
        createdAt: was.createdAt, updatedAt: was.updatedAt, ...(attachments.length || was.attachments ? { attachments } : {}),
        ...(tags.length ? { tags } : {}),
      });
    }
    const lanes = raw.lanes.map((l) => ({ id: l.id, name: String(l.name) }));
    if (!wantSealed) {
      // Plain text follows the same limits as any other edit.
      for (const l of lanes) l.name = ops.clean(l.name, 40);
      for (const c of cards) {
        c.title = ops.clean(c.title, 200); c.notes = c.notes.slice(0, 4000);
        if (c.tags) { const t = ops.tidyTags(c.tags); if (t.length) c.tags = t; else delete c.tags; }
      }
      if (lanes.some((l) => !l.name) || cards.some((c) => !c.title)) throw new Error("A lane or card came back empty.");
    }
    return { lanes, cards, theme: cur.theme, themeChosen: cur.themeChosen, ...(seal ? { sealed: seal } : {}) };
  }

  /**
   * Swap in a board and erase every copy of the old one: history, redo, chat, search index, and
   * unreferenced files. Durable Objects allow neither PRAGMA secure_delete nor VACUUM, so deleted
   * rows can linger in free pages until SQLite reuses them, and Cloudflare keeps 30 days of
   * point-in-time recovery. What was stored in plain text before this call can outlive it there.
   */
  private async swapBoard(next: Board) {
    this.sql`DELETE FROM history`;
    this.sql`DELETE FROM redo`;
    this.index.clear();
    this.resetTurnState();
    await this.persistMessages([], [], { _deleteStaleRows: true });
    this.setState(next);
    const keep = new Set(ops.attachmentIds(next));
    const prefix = `${this.name}/`;
    const doomed: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.env.ATTACHMENTS.list({ prefix, cursor });
      for (const obj of page.objects) if (!keep.has(obj.key.slice(prefix.length))) doomed.push(obj.key);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    for (let i = 0; i < doomed.length; i += 1000) await this.env.ATTACHMENTS.delete(doomed.slice(i, i + 1000));
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
    // The cloud model would have to read the board and the message. On an encrypted board it
    // never runs, and the plaintext message the SDK just stored is dropped again.
    if (this.state.sealed) {
      const keep = this.messages.filter((m) => m.role !== "user" || m.parts.every((p) => p.type !== "text" || isSealed(p.text)));
      await this.persistMessages(keep, [], { _deleteStaleRows: true });
      return new Response(SEALED_NOTICE, { status: 409 });
    }
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

const SEALED_NOTICE =
  "This board is end-to-end encrypted. Only the app, unlocked with the owner's passphrase, can read or change it, " +
  "so outside agents and the cloud assistant can't.";

/** Check an envelope's header (it's a JWE the browser made; the server can't open it) and build the seal info. */
function checkEnvelope(kid: unknown, envelope: unknown): SealInfo {
  if (typeof kid !== "string" || !/^[A-Za-z0-9_-]{8,32}$/.test(kid)) throw new Error("Bad key id.");
  if (typeof envelope !== "string" || envelope.length > 4000 || !/^eyJ[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){4}$/.test(envelope)) throw new Error("Bad key envelope.");
  let h: { alg?: string; enc?: string; p2c?: number; kid?: string };
  try {
    h = JSON.parse(atob(envelope.split(".")[0].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    throw new Error("Bad key envelope.");
  }
  if (h.alg !== ENVELOPE_ALG || h.enc !== "A256GCM" || !(Number(h.p2c) >= 210_000) || h.kid !== kid) throw new Error("The key envelope has to use PBES2-HS512+A256KW with at least 210,000 rounds.");
  return { v: 1, kid, envelope, since: new Date().toISOString() };
}

/** Proofs are base64url AES-GCM output over 32 bytes: 48 bytes, 64 characters. */
function checkProof(proof: unknown): string {
  if (typeof proof !== "string" || !/^[A-Za-z0-9_-]{64}$/.test(proof)) throw new Error("Bad key proof.");
  return proof;
}

// Chat frames that carry message content from the client. On an encrypted board none of them
// are accepted; clearing the chat, cancelling, and stream resume still work.
const CHAT_FRAMES_BLOCKED_WHEN_SEALED = new Set([
  "cf_agent_use_chat_request", "cf_agent_chat_messages", "cf_agent_tool_result", "cf_agent_tool_approval",
]);

function chatFrame(message: string): { type: string; id?: string } | null {
  if (!message.includes("cf_agent_")) return null;
  try {
    const m = JSON.parse(message) as { type?: unknown; id?: unknown };
    return typeof m.type === "string" ? { type: m.type, id: typeof m.id === "string" ? m.id : undefined } : null;
  } catch {
    return null;
  }
}

const clamp01 = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const finiteOrNull = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : null);
