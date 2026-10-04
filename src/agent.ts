import { AsyncLocalStorage } from "node:async_hooks";
import { AIChatAgent } from "@cloudflare/ai-chat";
import { callable, type Connection } from "agents";
import { convertToModelMessages, isStepCount, pruneMessages, streamText, tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { billingEnabled, dailyLimit, planFor, type Usage } from "./billing";
import * as ops from "./shared";
import { isSealed, NEEDS_CEO_TAG, THEME_IDS, type Attachment, type Board, type By, type Card, type SealInfo } from "./shared";
import { ENVELOPE_ALG, kidOf, proofHash } from "./sealed";
import { systemPrompt } from "./prompt";
import { agentEvents, agentQueue, type TaskEvent } from "./events";
import { endedCards, settledAsks } from "./presence-shared";
import { CardIndex } from "./search";
import { access, boardShared, logCards, syncSharing, type AuditCard } from "./members";
import {
  assertMayChange, CLOSE_FLOOD, CLOSE_NO_ACCESS, CLOSE_TOO_BIG, H_EMAIL, H_MEMBER, H_USER, memberCallNeeds, OWNER_ONLY, READ_ONLY, READ_ONLY_LAPSED,
  MEMBER_LIMITS, plainError, SLOW_DOWN, spendToken, type Access, type AccessFrame, type AccessReason, type ActivityFrame, type Bucket, type Effective,
} from "./member-rules";
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

/**
 * Who is behind the code that's running right now. Set where a request enters the object and
 * read by the write guard (`guard`) and by attribution (`by`), so neither has to trust an
 * argument. A member's entry is made only by `memberCall`, from a fresh membership check.
 */
type Caller = {
  kind: "owner" | "member";
  /** A member's account id. Not set for the owner. */
  id?: string;
  email: string | null;
  /** What this caller may do right now. Always "owner" for the owner. */
  effective: Effective;
  reason: AccessReason;
  via?: By["via"];
};
const callers = new AsyncLocalStorage<Caller>();

// Members' sockets (// TEAM_BOARDS). They are plain hibernating WebSockets this class accepts
// and answers itself. The Agents SDK and the chat SDK never see them: both only handle sockets
// whose attachment they wrote, so nothing they broadcast (chat messages, stream chunks, MCP
// server lists, state) reaches a member, and no frame a member sends reaches their handlers.
const MEMBER_TAG = "tasks-member";
/** One person, a handful of tabs. A fifth closes the oldest. */
const MAX_SOCKETS_PER_MEMBER = 4;
/** Every member's sockets on one board together. Past it, a new one is refused until some close. */
const MAX_MEMBER_SOCKETS = 48;
/** The biggest frame a member may send. A card's notes are 4,000 characters; a local assistant turn is eight small calls. */
const MEMBER_FRAME_MAX = 32 * 1024;
/**
 * How long a member's access check is trusted before D1 is asked again. Without it every frame
 * costs two D1 reads, so a flood of frames is a flood of reads. It's only ever trusted when it
 * was made after the last membership signal (`epoch`, below), so a removal or a role change
 * still holds from the member's very next frame.
 */
const ACCESS_CACHE_MS = 2000;
/** The least time between two pushes of the board to members' sockets: five a second, however fast it changes. */
const PUSH_INTERVAL_MS = 200;
/**
 * What a member's socket remembers between messages. `at` is when its access was last read
 * from D1, and `ep` is the membership epoch that read started under.
 */
type MemberMeta = { tm: 1; id: string; email: string; effective: Effective; reason: AccessReason; role: Access["role"]; plan: Access["plan"]; ownerEmail: string | null; at: number; ep: number };

/** The id of an RPC frame, read without parsing it: a refused frame shouldn't cost a JSON.parse of 32 KB. */
function rpcIdOf(message: string): string | null {
  const head = message.slice(0, 300);
  if (!head.includes('"rpc"')) return null;
  return /"id"\s*:\s*"([^"\\]{1,100})"/.exec(head)?.[1] ?? null;
}

function memberMeta(ws: WebSocket): MemberMeta | null {
  try {
    const a = ws.deserializeAttachment() as Partial<MemberMeta> | null;
    return a && a.tm === 1 && typeof a.id === "string" && typeof a.email === "string" ? (a as MemberMeta) : null;
  } catch {
    return null;
  }
}

function sendTo(ws: WebSocket, frame: string) {
  try { ws.send(frame); } catch { /* it closed under us */ }
}

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
    const gated: typeof this.onMessage = (connection, message) => {
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
    // Every socket the SDK handles is the owner's: fetch() below lets nobody else upgrade into
    // it. Say so for whatever the frame goes on to do.
    this.onMessage = (connection, message) =>
      callers.run({ kind: "owner", email: (connection.state as { email?: string } | null)?.email ?? this.ownerEmail(), effective: "owner", reason: null }, () => gated(connection, message));
  }

  // ---------- who's calling (// TEAM_BOARDS) ----------

  /**
   * The front door. The Worker has checked the session and names the caller in headers it set
   * itself (server.ts). The owner gets the Agents SDK as before. A member gets `acceptMember`,
   * and a request that names neither gets nothing.
   */
  override async fetch(request: Request): Promise<Response> {
    const member = request.headers.get(H_MEMBER);
    if (member !== null) return this.acceptMember(request, member);
    if (request.headers.get(H_USER) !== this.name) return new Response("Not found", { status: 404 });
    return super.fetch(request);
  }

  /** The owner's socket: remember their email for attribution. */
  onConnect(connection: Connection, ctx: { request: Request }) {
    let email: string | null = null;
    try { email = decodeURIComponent(ctx.request.headers.get(H_EMAIL) ?? ""); } catch { /* not ours */ }
    if (!email) return;
    connection.setState({ email });
    if (email !== this.ownerEmail()) this.sql`INSERT OR REPLACE INTO board_meta (k, v) VALUES ('owner_email', ${email})`;
  }

  /** The owner's email, as last seen on one of their sockets. For changes made with no socket in hand (a chat turn's tools). */
  private ownerEmail(): string | null {
    return this.sql<{ v: string }>`SELECT v FROM board_meta WHERE k = 'owner_email'`[0]?.v ?? null;
  }

  /** Who to name on a card this code is changing, or null when there's nobody to name. */
  private by(actor: Actor): By | null {
    const c = callers.getStore();
    const email = c?.email ?? this.ownerEmail();
    if (!email) return null;
    const via = c?.via ?? (actor === "agent" ? "agent" : undefined);
    return via ? { email, via } : { email };
  }

  /**
   * The write guard. Every change to the board passes through here twice: in `mutate`, before
   * anything is written, and again in `setState`, which every path ends in whether or not it
   * went through `mutate`. The owner may do anything. A member's change is checked against
   * what a writer may touch (assertMayChange in member-rules.ts): cards, and nothing else.
   * Code running with no caller (the Worker's RPC, a scheduled job) is the owner's own, since
   * a member has no way to start any.
   */
  private guard(before: Board, after: Board) {
    const c = callers.getStore();
    if (c?.kind === "member") assertMayChange(c.effective, c.reason, before, after);
  }

  override setState(next: Board) {
    this.guard(this.state, next);
    super.setState(next);
    this.pushMembers();
  }

  /** The board as a member's socket gets it. Never the passphrase envelope; an encrypted board has no members anyway. */
  private memberFrame(): string {
    const { sealed: _, ...board } = this.state;
    return JSON.stringify({ type: "cf_agent_state", state: board });
  }

  private accessFrame(m: MemberMeta, closed?: AccessFrame["closed"]): string {
    const frame: AccessFrame = {
      type: "tasks_access", board: this.name, ownerEmail: m.ownerEmail, role: m.role, effective: m.effective, reason: m.reason, plan: m.plan,
      ...(closed ? { closed } : {}),
    };
    return JSON.stringify(frame);
  }

  /**
   * The membership epoch. It moves the moment the Worker says membership or the owner's plan
   * changed (membersChanged), before anything is awaited, and every access check a socket
   * remembers is stamped with the epoch it started under. A remembered check from an older
   * epoch is never trusted: the next frame asks D1 again. It starts at the clock so nothing
   * remembered by an earlier instance of this object can match.
   */
  private epoch = Date.now();
  /** Token buckets, one per member id (spendToken in member-rules.ts). In memory: an idle board forgets them, and that's fine. */
  private buckets = new Map<string, Bucket>();

  /** Spend one of a member's tokens. */
  private spend(memberId: string) {
    const r = spendToken(this.buckets.get(memberId), Date.now());
    this.buckets.set(memberId, r.bucket);
    return r;
  }

  private recheckMs(): number {
    const n = Number((this.env as { MEMBER_RECHECK_SECONDS?: string }).MEMBER_RECHECK_SECONDS);
    return (Number.isFinite(n) && n >= 5 ? n : 30) * 1000;
  }

  /** Take the board away from a socket: say why, then close it. Nothing more is sent to it. */
  private dropMember(ws: WebSocket, m: MemberMeta, why: "removed" | "encrypted") {
    sendTo(ws, this.accessFrame({ ...m, role: null, effective: "none", reason: why === "encrypted" ? "encrypted" : "not_member", ownerEmail: null, plan: "free" }, why));
    try { ws.close(CLOSE_NO_ACCESS, why); } catch { /* already closed */ }
  }

  /**
   * Check a member's socket against D1 again. Removed, or the board got encrypted: the socket
   * is closed. Role or plan changed: the socket is told, and remembers the new answer.
   * Returns what the member may do now.
   */
  private async refresh(ws: WebSocket, m: MemberMeta, asked?: Promise<Access>): Promise<MemberMeta | null> {
    // Stamped with when and under which epoch the read began, not when it came back: an answer
    // that was already on its way when membership changed must not count as newer than the change.
    const ep = this.epoch;
    const at = Date.now();
    const a = await (asked ?? access(this.env, { id: m.id, email: m.email }, this.name, { sealed: !!this.state.sealed }));
    if (a.effective === "none" || a.role === "owner") {
      this.dropMember(ws, m, a.reason === "encrypted" ? "encrypted" : "removed");
      return null;
    }
    const next: MemberMeta = { ...m, role: a.role, effective: a.effective, reason: a.reason, plan: a.plan, ownerEmail: a.ownerEmail, at, ep };
    try { ws.serializeAttachment(next); } catch { return null; }
    if (next.effective !== m.effective || next.reason !== m.reason || next.role !== m.role || next.plan !== m.plan) sendTo(ws, this.accessFrame(next));
    return next;
  }

  /** A member connecting. The Worker checked them; check again here, with the same function, before anything is sent. */
  private async acceptMember(request: Request, raw: string): Promise<Response> {
    const refuse = () => new Response("Not found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return refuse();
    let who: { id?: unknown; email?: unknown };
    try { who = JSON.parse(decodeURIComponent(raw)) as typeof who; } catch { return refuse(); }
    if (typeof who.id !== "string" || typeof who.email !== "string" || who.id === this.name) return refuse();
    await this.__unsafe_ensureInitialized();
    // Connecting costs a token too, so reconnecting isn't a way around the bucket.
    if (!this.spend(who.id).ok) return new Response("Slow down", { status: 429, headers: { "Cache-Control": "no-store" } });
    const ep = this.epoch;
    const at = Date.now();
    const a = await access(this.env, { id: who.id, email: who.email }, this.name, { sealed: !!this.state.sealed });
    if (a.effective === "none" || a.role === "owner") return refuse();
    // One person, a handful of tabs. The oldest gives way.
    const mine = this.ctx.getWebSockets(`m:${who.id}`);
    const giveWay = mine.slice(0, Math.max(0, mine.length - MAX_SOCKETS_PER_MEMBER + 1));
    for (const old of giveWay) { try { old.close(1008, "too many tabs"); } catch { /* gone */ } }
    // And a ceiling for the board as a whole, whatever MAX_BOARD_MEMBERS is set to.
    if (this.ctx.getWebSockets(MEMBER_TAG).length - giveWay.length >= MAX_MEMBER_SOCKETS) {
      return new Response("This board has too many open tabs right now. Try again in a minute.", { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    this.markShared();
    const pair = new WebSocketPair();
    const meta: MemberMeta = { tm: 1, id: who.id, email: who.email, role: a.role, effective: a.effective, reason: a.reason, plan: a.plan, ownerEmail: a.ownerEmail, at, ep };
    this.ctx.acceptWebSocket(pair[1], [MEMBER_TAG, `m:${who.id}`]);
    pair[1].serializeAttachment(meta);
    // The same three frames useAgent expects from the SDK, so the client needs no second transport.
    sendTo(pair[1], JSON.stringify({ type: "cf_agent_identity", name: this.name, agent: "todo-agent" }));
    sendTo(pair[1], this.accessFrame(meta));
    sendTo(pair[1], this.memberFrame());
    await this.scheduleSweep();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * A frame from a member's socket. Exactly one kind does anything: an RPC call to a method on
   * the short list in member-rules.ts. State pushes, chat requests, tool results, and everything
   * else the SDK protocol has are dropped here without reaching the SDK.
   *
   * Before anything is parsed or read, the frame is measured and metered: one over
   * MEMBER_FRAME_MAX closes the socket, and every frame costs a token from the member's bucket.
   * With the bucket empty the call is refused with SLOW_DOWN, at no cost in D1 reads, and a
   * socket that keeps sending anyway is closed.
   *
   * Then their access. It's the answer D1 gave within the last ACCESS_CACHE_MS, if that answer
   * is from the current membership epoch; otherwise D1 is asked again. A removal, a role
   * change, or a plan change the Worker signalled moves the epoch, so it holds from the very
   * next frame. One that was never signalled holds within ACCESS_CACHE_MS for a member who's
   * sending, and at the next sweep for one who isn't.
   */
  private async memberMessage(ws: WebSocket, was: MemberMeta, message: string | ArrayBuffer) {
    const size = typeof message === "string" ? message.length : message.byteLength;
    if (size > MEMBER_FRAME_MAX) {
      try { ws.close(CLOSE_TOO_BIG, "frame too big"); } catch { /* already closed */ }
      return;
    }
    const spent = this.spend(was.id);
    if (!spent.ok) {
      const id = typeof message === "string" ? rpcIdOf(message) : null;
      if (id) sendTo(ws, JSON.stringify({ type: "rpc", id, done: true, success: false, error: SLOW_DOWN }));
      if (spent.flood) { try { ws.close(CLOSE_FLOOD, "slow down"); } catch { /* already closed */ } }
      return;
    }
    if (typeof message !== "string") return;
    let f: { type?: unknown; id?: unknown; method?: unknown; args?: unknown };
    try { f = JSON.parse(message) as typeof f; } catch { return; }
    if (!f || typeof f !== "object") return;
    if (f.type === "cf_agent_use_chat_request" && typeof f.id === "string") {
      sendTo(ws, JSON.stringify({ type: "cf_agent_use_chat_response", id: f.id, body: "The cloud assistant belongs to the board's owner. The in-browser assistant still works here.", done: true, error: true }));
      return;
    }
    if (f.type !== "rpc" || typeof f.id !== "string" || f.id.length > 100) return;
    const reply = (r: { success: true; result: unknown } | { success: false; error: string }) =>
      sendTo(ws, JSON.stringify({ type: "rpc", id: f.id, done: true, ...r }));
    const fresh = was.ep === this.epoch && Date.now() - was.at < ACCESS_CACHE_MS;
    const m = fresh ? was : await this.refresh(ws, was);
    if (!m) return;
    const needs = memberCallNeeds(f.method);
    if (!needs || !Array.isArray(f.args)) return reply({ success: false, error: OWNER_ONLY });
    if (needs === "writer" && m.effective !== "writer") return reply({ success: false, error: m.reason === "plan_lapsed" ? READ_ONLY_LAPSED : READ_ONLY });
    try {
      const fn = (this as unknown as Record<string, (...a: unknown[]) => unknown>)[f.method as string];
      const result = await callers.run({ kind: "member", id: m.id, email: m.email, effective: m.effective, reason: m.reason }, () => fn.apply(this, f.args as unknown[]));
      reply({ success: true, result: result === undefined ? null : result });
    } catch (e) {
      reply({ success: false, error: e instanceof Error ? e.message : "That didn't work." });
    }
  }

  // The platform's WebSocket events. A member's socket is handled here; everything else is the SDK's.
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const m = memberMeta(ws);
    if (!m) return this.lifecycle.webSocketMessage(ws, message);
    try {
      await this.__unsafe_ensureInitialized();
      await this.memberMessage(ws, m, message);
    } catch (e) {
      console.error("member socket message failed", (e as Error).message);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    if (!memberMeta(ws)) return this.lifecycle.webSocketClose(ws, code, reason, wasClean);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    if (!memberMeta(ws)) return this.lifecycle.webSocketError(ws, error);
  }

  /**
   * Send the board to members' sockets. A socket whose access was checked within the recheck
   * window gets it now; an older one is checked first and gets it only if it still has a way in.
   */
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private pushedAt = 0;

  /**
   * The board changed: get it to members' sockets. One change goes out at once. A burst is
   * coalesced: after a push, the next waits until PUSH_INTERVAL_MS has passed and then sends
   * the board as it is by then, so 400 writes in a few seconds are a couple of dozen frames per
   * socket instead of 400 copies of a growing board.
   */
  private pushMembers() {
    if (!this.ctx.getWebSockets(MEMBER_TAG).length) return;
    const wait = this.pushedAt + PUSH_INTERVAL_MS - Date.now();
    // An encrypted board closes its members' sockets, and that never waits.
    if (wait <= 0 || this.state.sealed) return this.flushMembers();
    this.pushTimer ??= setTimeout(() => {
      this.pushTimer = null;
      try { this.flushMembers(); } catch (e) { console.warn("member push failed", (e as Error).message); }
    }, wait);
  }

  private flushMembers() {
    this.pushedAt = Date.now();
    const sockets = this.ctx.getWebSockets(MEMBER_TAG);
    if (!sockets.length) return;
    const sealed = !!this.state.sealed;
    const frame = sealed ? "" : this.memberFrame();
    const stale: WebSocket[] = [];
    const cutoff = Date.now() - this.recheckMs();
    for (const ws of sockets) {
      const m = memberMeta(ws);
      if (!m) continue;
      if (sealed) this.dropMember(ws, m, "encrypted");
      else if (m.at < cutoff) stale.push(ws);
      else sendTo(ws, frame);
    }
    if (stale.length) this.ctx.waitUntil(this.recheck(stale, true).catch((e: Error) => console.warn("member recheck failed", e.message)));
  }

  /**
   * Check these sockets against D1 now. One read per member, started for all of them at once
   * and shared by that member's tabs, so nobody's close waits behind somebody else's read, and
   * one failed read leaves only that member's sockets for the next sweep.
   */
  private async recheck(sockets: WebSocket[], thenSend: boolean) {
    const asked = new Map<string, Promise<Access>>();
    await Promise.all(sockets.map(async (ws) => {
      const m = memberMeta(ws);
      if (!m) return;
      let a = asked.get(m.id);
      if (!a) asked.set(m.id, a = access(this.env, { id: m.id, email: m.email }, this.name, { sealed: !!this.state.sealed }));
      try {
        if ((await this.refresh(ws, m, a)) && thenSend) sendTo(ws, this.memberFrame());
      } catch (e) {
        console.warn("member recheck failed", (e as Error).message);
      }
    }));
  }

  /**
   * The Worker calls this the moment membership or the owner's plan changes (members.ts):
   * every member socket is checked against D1 now. A member who was removed, who left, or
   * whose access is gone gets one last `tasks_access` frame saying so and is closed (4403)
   * right here, before the request that changed it has answered. The Worker's relay
   * (server.ts) ends the browser's connection the moment it hears that close.
   */
  async membersChanged() {
    // First, and before any await: nothing a socket remembers about its access counts from here on.
    this.epoch += 1;
    this.markShared();
    await this.recheck(this.ctx.getWebSockets(MEMBER_TAG), false);
  }

  /**
   * The backstop for a signal that never came (a failed RPC, a plan that ran out with no
   * webhook): while any member is connected, check them all every MEMBER_RECHECK_SECONDS.
   * 30 seconds by default: short enough that a missed signal is a brief lag, not a hole, and
   * the cost is one small D1 read per connected member per run, only on boards being shared
   * right now. With nobody connected it stops.
   */
  async sweepMembers() {
    const sockets = this.ctx.getWebSockets(MEMBER_TAG);
    if (!sockets.length) return;
    await syncSharing(this.env, this.name).catch((e: Error) => console.warn("sharing state check failed", e.message));
    await this.recheck(sockets, false);
    // Buckets of members who are gone or have been quiet don't need keeping.
    const here = new Set(this.ctx.getWebSockets(MEMBER_TAG).map((ws) => memberMeta(ws)?.id));
    for (const id of this.buckets.keys()) if (!here.has(id)) this.buckets.delete(id);
    if (this.ctx.getWebSockets(MEMBER_TAG).length) await this.schedule(this.recheckMs() / 1000, "sweepMembers");
  }

  private async scheduleSweep() {
    if (this.getSchedules().some((s) => s.callback === "sweepMembers")) return;
    await this.schedule(this.recheckMs() / 1000, "sweepMembers");
  }

  /** Whether an attachment is on the board right now. A member may download those and no others (attachments.ts). */
  hasAttachment(id: string): boolean {
    return ops.attachmentIds(this.state).includes(id);
  }

  /**
   * Run `fn` as the person the Worker says is behind an RPC call. The owner is taken at the
   * Worker's word, which checked their session or token. Anyone else is looked up again here
   * and has to be a writer.
   */
  private async asUser<T>(who: { id: string; email: string } | undefined, via: By["via"], fn: () => T): Promise<T> {
    if (!who || who.id === this.name) {
      return callers.run({ kind: "owner", email: who?.email ?? this.ownerEmail(), effective: "owner", reason: null, ...(via ? { via } : {}) }, fn);
    }
    const a = await access(this.env, who, this.name, { sealed: !!this.state.sealed });
    if (a.effective === "none" || a.role === "owner") throw new Error("No such board.");
    return callers.run({ kind: "member", id: who.id, email: who.email, effective: a.effective, reason: a.reason, ...(via ? { via } : {}) }, fn);
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
    // The chat transcript is the owner's. Nothing a member does reads or writes it.
    if (callers.getStore()?.kind === "member") throw new Error(OWNER_ONLY);
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
    this.sql`CREATE TABLE IF NOT EXISTS board_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS member_deletes (member TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (member, day))`;
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
    const changed = fn(before);
    // Before anything is written: a member's change has to be one a writer may make.
    this.guard(before, changed);
    const after = ops.stampBy(before, changed, this.by(actor));
    ops.assertSealedBoard(after);
    // On a shared board a deleted card is written down. A member's deletions are counted first.
    const gone = this.goneCards(before, after);
    if (gone.length) this.spendDeletes(gone.length);
    const top = this.sql<{ grp: string | null }>`SELECT grp FROM history ORDER BY id DESC LIMIT 1`[0];
    if (!group || top?.grp !== group) {
      this.sql`INSERT INTO history (grp, label, board) VALUES (${group ?? null}, ${label}, ${JSON.stringify(before)})`;
      this.sql`DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY id DESC LIMIT ${HISTORY_LIMIT})`;
    }
    this.sql`DELETE FROM redo`;
    this.setState(after);
    if (gone.length) {
      const step = this.sql<{ id: number }>`SELECT id FROM history ORDER BY id DESC LIMIT 1`[0]?.id;
      this.noteCards("card_deleted", gone, this.by(actor), step);
    }
    this.reindex(before, after);
    const kept = new Set(ops.attachmentIds(after));
    if (ops.attachmentIds(before).some((id) => !kept.has(id))) void this.scheduleCleanup(ATTACHMENT_GRACE_S);
    if (actor === "you") this.publish(agentEvents(before, after));
    this.endClaims(before, after, actor);
    return after;
  }

  /**
   * A card that just reached the done lane, or was deleted, can't still be "working": tell
   * Presence so its claim ends now instead of 15 minutes later (endedCards in presence-shared.ts).
   * A question that was answered or taken back is told the same way, so the session that asked
   * stops reading "needs input" (settledAsks).
   * This is the one place the board talks to Presence about a change, and it only ever sends:
   * nothing comes back into board state, so it adds no undo step, flashes no card, and publishes
   * no agent event. An encrypted board keeps no presence, so there's nothing to tell.
   */
  private endClaims(before: Board, after: Board, by: Actor) {
    if (after.sealed) return;
    const ended = endedCards(before, after, by);
    // A question that was answered or taken back: the session that asked stops reading needs input.
    const settled = settledAsks(before, after);
    if (!ended.length && !settled.length) return;
    const presence = this.env.Presence.get(this.env.Presence.idFromName(this.name));
    if (settled.length) this.ctx.waitUntil(presence.settle(settled).catch((e: Error) => console.warn("settling questions failed", e.message)));
    if (ended.length) this.ctx.waitUntil(presence.finish(ended).catch((e: Error) => console.warn("ending claims failed", e.message)));
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

  // ---------- who deleted it (// TEAM_BOARDS) ----------
  //
  // Every card says who changed it last. A deleted card has nothing left to say it on, so on a
  // board that has ever been shared the deletion itself is recorded: in the owner's audit log
  // (logCards in members.ts), and as a line in every open tab. The name is `by()`, taken from
  // the connection that made the change, the same as the mark on a card. Nothing a client
  // sends is read into it, and none of this is callable.

  private _shared?: boolean;
  /** Whether anyone was ever invited to this board. Set once, by the first invite, and kept. */
  private sharedEver(): boolean {
    return (this._shared ??= this.sql<{ v: string }>`SELECT v FROM board_meta WHERE k = 'shared'`.length > 0);
  }

  /** The Worker's word that this board has been shared (members.ts). Deletions are recorded from here on. */
  markShared() {
    if (this.sharedEver()) return;
    this.sql`INSERT OR REPLACE INTO board_meta (k, v) VALUES ('shared', ${new Date().toISOString()})`;
    this._shared = true;
  }

  /** The cards in `before` that `after` no longer has, as the log keeps them. Nothing on a board that was never shared, or an encrypted one. */
  private goneCards(before: Board, after: Board): AuditCard[] {
    if (before.sealed || after.sealed || before.cards === after.cards || !this.sharedEver()) return [];
    const kept = new Set(after.cards.map((c) => c.id));
    const lanes = new Map(before.lanes.map((l) => [l.id, l.name]));
    return before.cards.filter((c) => !kept.has(c.id)).map((c) => ({ card: c.id, title: c.title.slice(0, 200), lane: lanes.get(c.laneId) ?? "" }));
  }

  /**
   * Count a member's deletions against their day. Each one becomes a row in a log nothing
   * prunes, so a member gets MEMBER_LIMITS.deletesPerDay of them and is refused past that,
   * before anything is written. The owner isn't counted.
   */
  private spendDeletes(n: number) {
    const c = callers.getStore();
    if (c?.kind !== "member") return;
    const who = c.id ?? c.email ?? "member";
    const day = this.today();
    const used = this.sql<{ n: number }>`SELECT n FROM member_deletes WHERE member = ${who} AND day = ${day}`[0]?.n ?? 0;
    if (used + n > MEMBER_LIMITS.deletesPerDay) {
      throw new Error(`[delete_limit] You've deleted ${used} cards on this board today, and a member can delete ${MEMBER_LIMITS.deletesPerDay} a day. Ask the board's owner, or try again tomorrow (UTC).`);
    }
    this.sql`DELETE FROM member_deletes WHERE day != ${day}`;
    this.sql`INSERT INTO member_deletes (member, day, n) VALUES (${who}, ${day}, ${n})
      ON CONFLICT(member, day) DO UPDATE SET n = n + ${n}`;
  }

  /** Record cards that were deleted or brought back, and tell every open tab. `step` is the undo step that reverses it, for the owner's tabs. */
  private noteCards(action: "card_deleted" | "card_restored", cards: AuditCard[], by: { email: string; via?: AuditCard["via"] } | null, step?: number) {
    const who = by ?? { email: this.ownerEmail() ?? "the owner" };
    const rows = cards.map((c) => ({ ...c, ...(who.via ? { via: who.via } : {}) }));
    this.ctx.waitUntil(logCards(this.env, this.name, who.email, action, rows).catch((e: Error) => console.error("recording a card change failed", action, e.message)));
    const frame: ActivityFrame = {
      type: "tasks_activity", action, by: { email: who.email, ...(who.via ? { via: who.via } : {}) },
      cards: cards.slice(0, 3).map((c) => ({ id: c.card, title: c.title, lane: c.lane })), count: cards.length,
    };
    const forMembers = JSON.stringify(frame);
    const forOwner = JSON.stringify(step === undefined ? frame : { ...frame, undo: step });
    const cutoff = Date.now() - this.recheckMs();
    for (const ws of this.ctx.getWebSockets()) {
      const m = memberMeta(ws);
      // A member's socket that hasn't been checked lately waits for the board itself, which is checked first (flushMembers).
      if (m) { if (m.at >= cutoff && m.effective !== "none") sendTo(ws, forMembers); }
      else if (!this.ctx.getTags(ws).includes(MEMBER_TAG)) sendTo(ws, forOwner);
    }
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
  async attach(cardId: string, att: Attachment, who?: { id: string; email: string }): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await this.asUser(who, undefined, () => this.mutate("Attach file", (b) => ops.addAttachment(b, cardId, att)));
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
  addCard(laneId: string, title: string, top = false, extra?: { notes?: string; due?: string | null; tags?: string[] }) {
    let id = "";
    this.mutate("Add card", (b) => {
      // `extra` comes from the New card dialog, which fills in everything at once.
      const r = ops.addCard(b, { title, laneId, top, notes: extra?.notes, due: extra?.due, tags: extra?.tags });
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
  askCeo(input: { id: string; question: string; options: string[]; recommended?: number }, email?: string): ToolOutcome {
    try {
      const board = callers.run({ kind: "owner", email: email ?? this.ownerEmail(), effective: "owner", reason: null, via: "agent" },
        () => this.mutate("Agent asked a question", (b) => ops.askCard(b, input.id, input), undefined, "agent"));
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

  /** Make a lane the to do, doing, or done lane (null for an ordinary lane). Whoever held the role gives it up. */
  @callable()
  setLaneRole(id: string, role: ops.LaneRole | null) {
    this.mutate("Lane role", (b) => ops.setLaneRole(b, id, role));
  }

  /** Dragging a card inside a sorted lane: keep the order on screen and drop the sort, as one change and one undo step. */
  @callable()
  setLaneManual(id: string, ids: string[]) {
    this.mutate("Manual order", (b) => ops.setLaneSort(ops.orderLane(b, id, ids), id, null));
  }

  /** Keep a lane sorted by `by` from now on (null for manual order). Saved on the lane, so it holds across reloads and browsers. */
  @callable()
  setLaneSort(id: string, by: ops.SortBy | null) {
    this.mutate(by ? "Sort lane" : "Manual order", (b) => ops.setLaneSort(b, id, by));
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
  private restore(board: Board, how: "undo" | "redo") {
    const before = this.state;
    // The passphrase envelope isn't undoable either: an undo must never bring back an old passphrase.
    // Whoever undid or redid it made the last change to the cards that came back different.
    this.setState(ops.stampBy(before, ops.keepSettings(board, before), this.by("you")));
    // Undoing "Add card" deletes a card, and undoing a delete brings one back. Both are written down.
    const who = this.by("you");
    const stamp = who ? { email: who.email, via: how } : null;
    const gone = this.goneCards(before, this.state);
    if (gone.length) this.noteCards("card_deleted", gone, stamp);
    const back = this.goneCards(this.state, before);
    if (back.length) this.noteCards("card_restored", back, stamp);
    this.reindex(before, this.state);
    // Undo and redo can finish or remove a card too (redoing a move to Done, undoing "Add card").
    // The other direction brings nothing back: a claim that ended stays ended.
    this.endClaims(before, this.state, "you");
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
    this.restore(JSON.parse(top.board) as Board, "undo");
    return top.label;
  }

  /**
   * Undo one particular step, and only if it's still the last one. The "Undo" on the toast
   * that says a member deleted a card names the step it means, so it can't undo something
   * else that landed in between. Null when the board has moved on.
   */
  @callable()
  undoIf(step: number): string | null {
    const top = this.sql<{ id: number }>`SELECT id FROM history ORDER BY id DESC LIMIT 1`[0];
    return top && top.id === step ? this.undo() : null;
  }

  /** Redo the last undone change. Returns what was redone, or null when there's nothing to redo. */
  @callable()
  redo(): string | null {
    const top = this.sql<{ id: number; label: string; board: string }>`
      SELECT id, label, board FROM redo ORDER BY id DESC LIMIT 1`[0];
    if (!top) return null;
    this.sql`DELETE FROM redo WHERE id = ${top.id}`;
    this.sql`INSERT INTO history (grp, label, board) VALUES (NULL, ${top.label}, ${JSON.stringify(this.state)})`;
    this.restore(JSON.parse(top.board) as Board, "redo");
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
  runTool(name: ToolName, input: unknown, group?: string, actor: Actor = "you", email?: string): ToolOutcome {
    // Called over RPC by the MCP endpoint, which has checked the owner's token: name them.
    if (!callers.getStore() && actor === "agent") {
      return callers.run({ kind: "owner", email: email ?? this.ownerEmail(), effective: "owner", reason: null, via: "agent" }, () => this.runTool(name, input, group, actor));
    }
    const t = BOARD_TOOLS[name];
    if (!t) return { ok: false, summary: `Unknown tool ${name}` };
    try {
      const args = t.inputSchema.parse(input);
      let summary = "";
      let ids: string[] | undefined;
      const board = this.mutate(t.label, (b) => {
        const r = (t.apply as (b: Board, i: typeof args) => { board: Board; summary: string; ids?: string[] })(b, args);
        summary = r.summary;
        ids = r.ids;
        return r.board;
      }, group, actor);
      return { ok: true, summary, board: ops.describeBoard(board), ids };
    } catch (e) {
      return { ok: false, summary: plainError((e as Error).message) };
    }
  }

  /**
   * An outside agent just made a call over MCP (mcp.ts). The first one is remembered on the
   * board, which is what takes "No agent connected yet" off every open tab. It's a setting, not
   * a change: no undo step, no event on the feed, and no card moves or flashes. Every call after
   * the first returns without touching anything.
   */
  noteAgentSeen() {
    const next = ops.markAgentSeen(this.state, new Date().toISOString());
    if (next !== this.state) this.setState(next);
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

  /** One card in full for the MCP get_card tool: its text, and its attachments so the caller can fetch the files. Null when there's no such card or the board is encrypted. */
  cardDetail(id: string): { text: string; attachments: Attachment[]; done: boolean } | null {
    if (this.state.sealed) return null;
    const text = ops.describeCard(this.state, id);
    if (text === null) return null;
    const card = this.state.cards.find((c) => c.id === id);
    // Done is being in the done lane, the same rule that ends a claim (endedCards in presence-shared.ts).
    return { text, attachments: card?.attachments ?? [], done: !!card && card.laneId === ops.doneLaneId(this.state.lanes) };
  }

  /** Lane names and card counts, for what a write tool echoes over MCP. */
  laneCounts(): string {
    return this.state.sealed ? "" : ops.describeLaneCounts(this.state);
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
    const caller = callers.getStore();
    // The assistant acting on this person's message. A member's turn runs under their own
    // role, so the write guard decides what it may do like any other change of theirs.
    const run = () => calls.map((c) => this.runTool(c.name, c.input, group));
    const outcomes = caller ? callers.run({ ...caller, via: "assistant" }, run) : run();
    const done = outcomes.filter((o) => o.ok).map((o) => o.summary);
    const reply = done.length ? `${done.join(". ")}.` : "That didn't work; try telling me again.";
    // The transcript is the owner's chat. A member's local turn changes the board and leaves no message in it.
    if (caller?.kind === "member") return { outcomes, reply };
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
    const next = [...this.messages, user, assistant] as TodoAgent["messages"];
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
    // An encrypted board is closed to everyone but its owner, so it can't be one that's shared.
    if (await boardShared(this.env, this.name)) throw new Error(SHARED_NOTICE);
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
    // The agents that were connected still are, so the fresh board doesn't ask for one again.
    const { sealed: _gone, ...settings } = this.state;
    await this.swapBoard(ops.keepSettings(ops.newBoard(), settings));
    this.sql`DELETE FROM seal_meta`;
    this.index.clear();
  }

  /** What the upload endpoint may accept: files encrypted under `kid`, and plain ones only while turning encryption off. */
  uploadPolicy(memberId?: string): { kid: string | null; plainStaging: boolean; slow?: true } {
    const kid = this.state.sealed?.kid ?? null;
    // A member's uploads draw on the same bucket as their socket, and are turned away here,
    // before the file is read or stored.
    if (memberId && !this.spend(memberId).ok) return { kid, plainStaging: false, slow: true };
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
    // A lane's sort is a plain setting, not content, so it rides along unencrypted either way.
    const lanes: ops.Lane[] = raw.lanes.map((l) => ({ id: l.id, name: String(l.name), ...(ops.SORTS.some((o) => o.by === l.sort) ? { sort: l.sort } : {}) }));
    if (!wantSealed) {
      // Plain text follows the same limits as any other edit.
      for (const l of lanes) l.name = ops.clean(l.name, 40);
      for (const c of cards) {
        c.title = ops.clean(c.title, 200); c.notes = c.notes.slice(0, 4000);
        if (c.tags) { const t = ops.tidyTags(c.tags); if (t.length) c.tags = t; else delete c.tags; }
      }
      if (lanes.some((l) => !l.name) || cards.some((c) => !c.title)) throw new Error("A lane or card came back empty.");
    }
    return ops.keepSettings({ lanes, cards, theme: cur.theme }, { ...cur, sealed: seal });
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

  /** A cloud turn's tool calls: the assistant, on the owner's behalf. Only the owner's socket can start one. */
  private asAssistant<T>(fn: () => T): T {
    return callers.run({ kind: "owner", email: this.ownerEmail(), effective: "owner", reason: null, via: "assistant" }, fn);
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
          return [name, tool({ description, inputSchema, execute: async (input: unknown) => this.asAssistant(() => this.runTool(name, input, group)) })];
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

/** Starts with its code, `[board_shared]`, so the app can tell it from any other failure. */
const SHARED_NOTICE = "[board_shared] A shared board can't be encrypted. Remove its members and revoke its pending invites first.";

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
