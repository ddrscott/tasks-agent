// Which Claude Code sessions are running, and which cards they've claimed.
//
// Presence, not a log. Each session overwrites one small row: project (the folder name),
// machine, state, one line about its last action, and when it was last seen. Claude Code
// hooks of type "http" post their event here (README → // SESSIONS has the config), and the
// row is built from a handful of fields. Prompts, tool output, and transcripts are never
// read or stored; Claude Code already keeps transcripts on the machine that ran them.
//
// One Presence Durable Object per user, apart from the board on purpose. Nothing here goes
// through TodoAgent.mutate, so a session reporting in can't add an undo step, flash a card,
// or reindex search. The browser gets the list over its own WebSocket (/tasks/presence).
//
// Claims live here too. A lead agent claims a card with its session id over MCP
// (claim_card); the object is single-threaded, so two leads can't both win. A claim holds
// while its session is live and can be taken over once the session has gone quiet.
// A session with no hooks (any MCP client) is heard from through its MCP calls alone, and its
// row is written by the claim rules in presence-shared.ts.
//
// A session that asked the owner a question (ask_ceo) keeps its card and reads "needs input"
// with the question until it's answered: the claim holds the question, and view() says so.

import { DurableObject } from "cloudflare:workers";
import { getAgentByName } from "agents";

import {
  afterAsk, afterClaim, afterEnded, afterRelease, afterSettled, known, LAPSED, STALE_MS, withAsks,
  type Claim, type ClaimRow, type Ended, type PresenceView, type Session, type SessionState, type Settled,
} from "./presence-shared";

export { STALE_MS, type Claim, type PresenceView, type Session, type SessionState };

/** A claim holds this long after its session was last seen. Longer than stale, so a lead that's thinking keeps its card. */
export const CLAIM_LIVE_MS = 15 * 60 * 1000;
/** Rows nobody has updated in this long are deleted. */
export const EXPIRE_MS = 24 * 60 * 60 * 1000;
/** PostToolUse fires on every tool call; a session that's already "working" is rewritten at most this often. */
const WORKING_EVERY_MS = 30 * 1000;
/** Sessions kept per user. The oldest go first. */
const MAX_SESSIONS = 200;

const clean = (v: unknown, max: number) =>
  (typeof v === "string" ? v : "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

const basename = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";

/** A report, after everything Claude Code sent has been cut down to what's kept. */
export type Report = {
  id: string;
  project: string;
  machine: string;
  agent: string;
  cwd: string;
  link: string;
  /** null means the session ended and its row goes away. "keep" leaves the state as it was. */
  state: SessionState | "keep" | null;
  last: string;
  /** PostToolUse and friends: fine to drop when one landed moments ago. */
  routine: boolean;
};

/** Notifications that mean Claude is waiting on a person. The rest (auth_success, agent_completed, …) are just news. */
const WAITING = new Set(["permission_prompt", "idle_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]);

/** Tools whose target is a file: the line says which file, by name only. */
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit", "MultiEdit"]);

/**
 * Turn a Claude Code hook payload into a report. Only these fields are read: session_id, cwd,
 * hook_event_name, tool_name, tool_input.file_path, tool_input.description, message, and
 * notification_type. The prompt, tool results, and transcript path are ignored. A Bash
 * command is never kept, since commands carry secrets; its description is, when there is one.
 */
export function reportFrom(body: unknown, hints: { machine?: string | null; agent?: string | null; link?: string | null }): Report | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const id = clean(b.session_id, 80);
  if (!/^[\w.:-]{6,80}$/.test(id)) return null;
  const cwd = clean(b.cwd, 300);
  const event = clean(b.hook_event_name, 40);
  const tool = clean(b.tool_name, 60);
  const input = (b.tool_input && typeof b.tool_input === "object" ? b.tool_input : {}) as Record<string, unknown>;

  let state: Report["state"] = "working";
  let last = "";
  let routine = false;
  switch (event) {
    case "SessionEnd":
      state = null;
      break;
    case "SessionStart":
      state = "idle";
      last = "session started";
      break;
    case "Stop":
      state = "idle";
      last = "finished its turn";
      break;
    case "PermissionRequest":
      state = "needs-input";
      last = tool ? `wants to use ${tool}` : "waiting on a permission";
      break;
    case "Notification": {
      const kind = clean(b.notification_type, 40);
      // "idle_prompt" is Claude saying it has been waiting on you for a while. A type this
      // code doesn't know yet counts as waiting too: a false "needs input" beats a missed one.
      const news = kind !== "" && !WAITING.has(kind) && /^(auth_success|agent_completed|elicitation_complete|elicitation_response|quota_)/.test(kind);
      state = news ? "keep" : "needs-input";
      last = clean(b.message, 120) || (kind ? kind.replace(/_/g, " ") : "waiting on you");
      break;
    }
    case "UserPromptSubmit":
      last = "got a prompt";
      break;
    default: {
      // PreToolUse, PostToolUse, SubagentStop, and anything newer: the session is doing something.
      routine = true;
      const file = FILE_TOOLS.has(tool) ? basename(clean(input.file_path ?? input.notebook_path, 300)) : "";
      const what = file || clean(input.description, 80);
      last = tool ? (what ? `${tool}: ${what}` : tool) : event || "working";
    }
  }

  const link = clean(hints.link, 300);
  return {
    id,
    project: basename(cwd),
    machine: clean(hints.machine, 60),
    agent: clean(hints.agent, 40),
    cwd,
    link: /^https:\/\/[^\s]+$/.test(link) ? link : "",
    state,
    last: last.slice(0, 120),
    routine,
  };
}

type Row = {
  id: string; project: string; machine: string; agent: string; state: SessionState;
  last: string; cwd: string; link: string; started_at: number; seen_at: number;
};

export class Presence extends DurableObject<Env> {
  private sql: SqlStorage;
  /** Whether the board is encrypted, remembered briefly so each report isn't an extra call. */
  private sealed: { value: boolean; at: number } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, project TEXT NOT NULL, machine TEXT NOT NULL, agent TEXT NOT NULL,
      state TEXT NOT NULL, last TEXT NOT NULL, cwd TEXT NOT NULL, link TEXT NOT NULL,
      started_at INTEGER NOT NULL, seen_at INTEGER NOT NULL)`);
    // hooks: 1 once a hook has reported for the session. A row with 0 has only ever claimed cards
    // over MCP, and is written by the claim rules in presence-shared.ts instead.
    try {
      this.sql.exec("ALTER TABLE sessions ADD COLUMN hooks INTEGER NOT NULL DEFAULT 0");
      this.sql.exec("UPDATE sessions SET hooks = 1 WHERE cwd != ''");
    } catch { /* the column is already there */ }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS claims (
      card_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent TEXT NOT NULL, claimed_at INTEGER NOT NULL)`);
    // asked: the question the claim's session put on the card and is waiting on, while it's open.
    try {
      this.sql.exec("ALTER TABLE claims ADD COLUMN asked TEXT NOT NULL DEFAULT ''");
      this.sql.exec("ALTER TABLE claims ADD COLUMN asked_at INTEGER NOT NULL DEFAULT 0");
    } catch { /* the columns are already there */ }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** The user this object belongs to. Set by the Worker on the first call, since an object can't read its own name. */
  private user(set?: string): string | null {
    if (set) this.sql.exec("INSERT INTO meta (k, v) VALUES ('user', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", set);
    return (this.sql.exec("SELECT v FROM meta WHERE k = 'user'").toArray()[0]?.v as string | undefined) ?? set ?? null;
  }

  /**
   * An encrypted board keeps no presence. Someone who turned encryption on has said the
   * server shouldn't hold anything readable about their work, and project names and "last
   * action" lines are exactly that. Hooks have no key, so they couldn't encrypt it either.
   */
  private async boardSealed(user: string): Promise<boolean> {
    if (this.sealed && Date.now() - this.sealed.at < 60_000) return this.sealed.value;
    const agent = await getAgentByName(this.env.TodoAgent, user);
    const value = await agent.isSealed();
    this.sealed = { value, at: Date.now() };
    if (value) this.wipe();
    return value;
  }

  /** Erase everything. Called when a board turns encryption on. */
  wipe() {
    this.sql.exec("DELETE FROM sessions");
    this.sql.exec("DELETE FROM claims");
    this.sealed = null;
    this.broadcast();
  }

  private expire(now = Date.now()) {
    this.sql.exec("DELETE FROM sessions WHERE seen_at < ?", now - EXPIRE_MS);
    this.sql.exec(
      "DELETE FROM sessions WHERE id NOT IN (SELECT id FROM sessions ORDER BY seen_at DESC LIMIT ?)", MAX_SESSIONS);
    // A claim whose session is gone or has been quiet too long is free again.
    this.sql.exec(
      "DELETE FROM claims WHERE session_id NOT IN (SELECT id FROM sessions WHERE seen_at >= ?)", now - CLAIM_LIVE_MS);
    // A session that only ever claimed is "working" because it holds a card. With none left, it isn't.
    this.sql.exec(
      "UPDATE sessions SET state = 'idle', last = ? WHERE hooks = 0 AND state = 'working' AND id NOT IN (SELECT session_id FROM claims)", LAPSED);
  }

  view(): PresenceView {
    const now = Date.now();
    this.expire(now);
    const rows = (this.sql.exec("SELECT * FROM sessions ORDER BY seen_at DESC").toArray() as unknown as Row[]).map((r) => ({
      id: r.id, project: r.project, machine: r.machine, agent: r.agent, state: r.state, last: r.last,
      cwd: r.cwd, link: r.link, startedAt: r.started_at, seenAt: r.seen_at,
    }));
    const claims: Claim[] = (this.sql.exec("SELECT * FROM claims ORDER BY claimed_at").toArray() as unknown as
      { card_id: string; session_id: string; agent: string; claimed_at: number; asked: string; asked_at: number }[])
      .map((r) => ({
        cardId: r.card_id, sessionId: r.session_id, agent: r.agent, claimedAt: r.claimed_at,
        ...(r.asked ? { asked: r.asked, askedAt: r.asked_at } : {}),
      }));
    // A session with a question open reads needs input, whatever its hooks or claims last wrote.
    return { sessions: withAsks(rows, claims), claims, now };
  }

  private broadcast() {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    const msg = JSON.stringify(this.view());
    for (const ws of sockets) {
      try { ws.send(msg); } catch { /* closing */ }
    }
  }

  /** One session reporting in. Returns what happened, for the hook's response. */
  async report(user: string, r: Report): Promise<"stored" | "skipped" | "ended" | "sealed"> {
    this.user(user);
    if (await this.boardSealed(user)) return "sealed";
    const now = Date.now();
    if (r.state === null) {
      this.sql.exec("DELETE FROM sessions WHERE id = ?", r.id);
      this.sql.exec("DELETE FROM claims WHERE session_id = ?", r.id);
      this.broadcast();
      return "ended";
    }
    const prev = this.sql.exec("SELECT state, seen_at, started_at, agent, link FROM sessions WHERE id = ?", r.id).toArray()[0] as
      { state: SessionState; seen_at: number; started_at: number; agent: string; link: string } | undefined;
    // Tool calls come many times a minute. If the row already says "working", one write per 30s is plenty.
    if (r.routine && prev?.state === "working" && now - prev.seen_at < WORKING_EVERY_MS) return "skipped";
    const state = r.state === "keep" ? prev?.state ?? "idle" : r.state;
    this.sql.exec(
      `INSERT INTO sessions (id, project, machine, agent, state, last, cwd, link, started_at, seen_at, hooks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET project = excluded.project, machine = excluded.machine, agent = excluded.agent,
         state = excluded.state, last = excluded.last, cwd = excluded.cwd, link = excluded.link, seen_at = excluded.seen_at, hooks = 1`,
      r.id, r.project, r.machine, r.agent || prev?.agent || "", state, r.last, r.cwd, r.link || prev?.link || "",
      prev?.started_at ?? now, now,
    );
    await this.ctx.storage.setAlarm(now + STALE_MS + 1000);
    this.broadcast();
    return "stored";
  }

  /** Stale and expiry are about time passing, so open tabs get a fresh list when it does. */
  async alarm() {
    this.broadcast();
    const next = this.sql.exec("SELECT MAX(seen_at) AS t FROM sessions").toArray()[0]?.t as number | null;
    if (next && Date.now() - next < EXPIRE_MS) await this.ctx.storage.setAlarm(Date.now() + 10 * 60 * 1000);
  }

  /**
   * Claim a card for a session. Refused while another live session holds it. Claiming also
   * counts as the session reporting in, so a lead with no hooks installed can still hold cards.
   * `title` is the card's, from the board (mcp.ts), for the session's last-action line.
   */
  claim(user: string, input: { cardId: string; sessionId: string; title?: string; agent?: string; machine?: string; project?: string }):
    { ok: true; claim: Claim; tookOver?: string } | { ok: false; holder: Claim; session: Session | null } {
    this.user(user);
    const now = Date.now();
    const cardId = clean(input.cardId, 40);
    const sessionId = clean(input.sessionId, 80);
    const agent = clean(input.agent, 40) || "agent";
    this.expire(now);
    const held = this.sql.exec("SELECT * FROM claims WHERE card_id = ?", cardId).toArray()[0] as
      { card_id: string; session_id: string; agent: string; claimed_at: number } | undefined;
    // expire() already dropped claims of quiet sessions, so a holder that's left is live.
    const won = !held || held.session_id === sessionId;
    if (won) {
      this.sql.exec(
        `INSERT INTO claims (card_id, session_id, agent, claimed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(card_id) DO UPDATE SET session_id = excluded.session_id, agent = excluded.agent`,
        cardId, sessionId, agent, held?.claimed_at ?? now,
      );
    }
    this.heard(sessionId, now, agent, (prev, holds) => afterClaim(
      prev, { agent: clean(input.agent, 40), machine: known(clean(input.machine, 60)), project: known(clean(input.project, 80)) },
      clean(input.title, 80), won, holds,
    ));
    void this.ctx.storage.setAlarm(now + STALE_MS + 1000);
    this.broadcast();
    if (!won) {
      return {
        ok: false,
        holder: { cardId, sessionId: held.session_id, agent: held.agent, claimedAt: held.claimed_at },
        session: this.view().sessions.find((s) => s.id === held.session_id) ?? null,
      };
    }
    return { ok: true, claim: { cardId, sessionId, agent, claimedAt: held?.claimed_at ?? now } };
  }

  /** The agent kind a session's row holds, when it has a row and said. */
  private agentOf(sessionId: string): string {
    return (this.sql.exec("SELECT agent FROM sessions WHERE id = ?", sessionId).toArray()[0]?.agent as string | undefined) ?? "";
  }

  /**
   * A session asked a question on a card (ask_ceo in mcp.ts). The asker is the session the call
   * named, or else whoever holds the card, so an agent that leaves session_id off still shows as
   * waiting. It keeps the card: a card waiting on its owner isn't up for grabs, and the held
   * claim is what puts the session's line on the card. If the call named a session and nobody
   * holds the card, asking claims it. While the question is open the session reads needs input
   * (withAsks). Returns the session that's now waiting, or null when none could be tied to it.
   */
  asked(user: string, input: { cardId: string; sessionId?: string; question: string; title?: string }): string | null {
    this.user(user);
    const now = Date.now();
    const cardId = clean(input.cardId, 40);
    const question = clean(input.question, 240);
    const named = clean(input.sessionId, 80);
    this.expire(now);
    const held = this.sql.exec("SELECT session_id FROM claims WHERE card_id = ?", cardId).toArray()[0] as { session_id: string } | undefined;
    if (named && /^[\w.:-]{6,80}$/.test(named) && !held) {
      this.sql.exec("INSERT INTO claims (card_id, session_id, agent, claimed_at) VALUES (?, ?, ?, ?)", cardId, named, this.agentOf(named) || "agent", now);
    }
    const asker = held?.session_id ?? (named && /^[\w.:-]{6,80}$/.test(named) ? named : "");
    if (!asker) return null;
    // Another live session holds the card: the question stands on the card, and the caller was heard from.
    if (named && asker !== named) {
      this.touch({ sessionIds: [named] });
      return null;
    }
    this.sql.exec("UPDATE claims SET asked = ?, asked_at = ? WHERE card_id = ?", question, now, cardId);
    this.heard(asker, now, "", (prev, holds) => afterAsk(prev, clean(input.title, 80), holds));
    void this.ctx.storage.setAlarm(now + STALE_MS + 1000);
    this.broadcast();
    return asker;
  }

  /**
   * Questions that just closed on the board (settledAsks in presence-shared.ts; the board calls
   * this next to finish). The session behind one stops reading needs input. It keeps the card, so
   * one that only claims is working again; one with hooks shows what its hooks last wrote. Nobody
   * was heard from here, so no last-seen time moves.
   */
  settle(closed: Settled[]) {
    this.expire();
    let changed = false;
    for (const e of closed) {
      const cardId = clean(e.cardId, 40);
      const c = this.sql.exec("SELECT session_id, asked FROM claims WHERE card_id = ?", cardId).toArray()[0] as { session_id: string; asked: string } | undefined;
      if (!c?.asked) continue;
      this.sql.exec("UPDATE claims SET asked = '', asked_at = 0 WHERE card_id = ?", cardId);
      changed = true;
      const prev = this.sql.exec("SELECT project, machine, agent, state, last, hooks FROM sessions WHERE id = ?", c.session_id).toArray()[0] as
        (ClaimRow & { hooks: number }) | undefined;
      if (!prev || prev.hooks) continue;
      const holds = this.sql.exec("SELECT COUNT(*) AS n FROM claims WHERE session_id = ?", c.session_id).toArray()[0].n as number;
      const row = afterSettled(prev, { title: clean(e.title, 80), how: e.how }, holds);
      this.sql.exec("UPDATE sessions SET state = ?, last = ? WHERE id = ?", row.state, row.last.slice(0, 120), c.session_id);
    }
    if (changed) this.broadcast();
  }

  /**
   * An MCP call that isn't a claim still says its session is alive: wait_for_answer most of all,
   * since an agent polling for an answer makes no other call. Moves the last-seen time of the
   * sessions named, and of the sessions holding the cards named, and nothing else. A session with
   * no row isn't given one: only a claim or a hook makes a row.
   */
  touch(input: { sessionIds?: string[]; cardIds?: string[] }) {
    const now = Date.now();
    this.expire(now);
    const ids = new Set((input.sessionIds ?? []).map((id) => clean(id, 80)).filter(Boolean));
    for (const cardId of input.cardIds ?? []) {
      const c = this.sql.exec("SELECT session_id FROM claims WHERE card_id = ?", clean(cardId, 40)).toArray()[0] as { session_id: string } | undefined;
      if (c) ids.add(c.session_id);
    }
    let moved = false;
    for (const id of ids) {
      moved = this.sql.exec("UPDATE sessions SET seen_at = ? WHERE id = ?", now, id).rowsWritten > 0 || moved;
    }
    if (!moved) return;
    void this.ctx.storage.setAlarm(now + STALE_MS + 1000);
    this.broadcast();
  }

  /**
   * A claim or release counts as hearing from the session. One that reports through hooks only
   * has its clock moved: the hooks say what it's doing. One that doesn't gets its row from `rule`.
   */
  private heard(sessionId: string, now: number, agent: string, rule: (prev: ClaimRow | null, holds: number) => ClaimRow) {
    const prev = this.sql.exec("SELECT project, machine, agent, state, last, hooks FROM sessions WHERE id = ?", sessionId).toArray()[0] as
      (ClaimRow & { hooks: number }) | undefined;
    if (prev?.hooks) {
      this.sql.exec("UPDATE sessions SET seen_at = ?, agent = CASE WHEN agent = '' THEN ? ELSE agent END WHERE id = ?", now, agent, sessionId);
      return;
    }
    const holds = this.sql.exec("SELECT COUNT(*) AS n FROM claims WHERE session_id = ?", sessionId).toArray()[0].n as number;
    const row = rule(prev ?? null, holds);
    this.sql.exec(
      `INSERT INTO sessions (id, project, machine, agent, state, last, cwd, link, started_at, seen_at, hooks)
       VALUES (?, ?, ?, ?, ?, ?, '', '', ?, ?, 0)
       ON CONFLICT(id) DO UPDATE SET project = excluded.project, machine = excluded.machine, agent = excluded.agent,
         state = excluded.state, last = excluded.last, seen_at = excluded.seen_at`,
      sessionId, row.project, row.machine, row.agent, row.state, row.last.slice(0, 120), now, now,
    );
  }

  /** Give a card back. Only the session holding it can. `title` is the card's, when it still exists. */
  release(input: { cardId: string; sessionId: string; title?: string }): boolean {
    const now = Date.now();
    const cardId = clean(input.cardId, 40);
    const sessionId = clean(input.sessionId, 80);
    this.expire(now);
    const held = this.sql.exec("SELECT agent FROM claims WHERE card_id = ? AND session_id = ?", cardId, sessionId).toArray()[0] as { agent: string } | undefined;
    if (!held) return false;
    this.sql.exec("DELETE FROM claims WHERE card_id = ? AND session_id = ?", cardId, sessionId);
    // A session whose row is gone (it ended) has nothing to update: releasing doesn't bring it back.
    if (this.sql.exec("SELECT 1 FROM sessions WHERE id = ?", sessionId).toArray().length) {
      this.heard(sessionId, now, "", (prev, holds) => afterRelease(prev!, clean(input.title, 80), holds));
    }
    this.broadcast();
    return true;
  }

  /**
   * Cards that just reached the last lane or were deleted (endedCards in presence-shared.ts; the
   * board calls this from TodoAgent.mutate and from undo and redo). Their claims are over: nothing
   * is working on a card that's done or gone. A session that reports through hooks keeps its row
   * as its hooks left it. One that only claims gets the line from afterEnded, and goes idle if
   * that was its last card. Nobody was heard from here, so no last-seen time moves.
   */
  finish(ended: Ended[]) {
    this.expire();
    let dropped = false;
    for (const e of ended) {
      const cardId = clean(e.cardId, 40);
      const held = this.sql.exec("SELECT session_id FROM claims WHERE card_id = ?", cardId).toArray()[0] as { session_id: string } | undefined;
      if (!held) continue;
      this.sql.exec("DELETE FROM claims WHERE card_id = ?", cardId);
      dropped = true;
      const prev = this.sql.exec("SELECT project, machine, agent, state, last, hooks FROM sessions WHERE id = ?", held.session_id).toArray()[0] as
        (ClaimRow & { hooks: number }) | undefined;
      if (!prev || prev.hooks) continue;
      const holds = this.sql.exec("SELECT COUNT(*) AS n FROM claims WHERE session_id = ?", held.session_id).toArray()[0].n as number;
      const row = afterEnded(prev, { title: clean(e.title, 80), how: e.how, lane: clean(e.lane, 40), by: e.by }, holds);
      this.sql.exec("UPDATE sessions SET state = ?, last = ? WHERE id = ?", row.state, row.last.slice(0, 120), held.session_id);
    }
    if (dropped) this.broadcast();
  }

  /** The browser's live list. The Worker has already checked the session cookie; `x-user` names the user. */
  async fetch(req: Request): Promise<Response> {
    const user = req.headers.get("x-user");
    if (!user) return new Response("Sign in first", { status: 401 });
    this.user(user);
    const sealed = await this.boardSealed(user);
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json(sealed ? { sessions: [], claims: [], now: Date.now(), sealed: true } : this.view());
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify(sealed ? { sessions: [], claims: [], now: Date.now(), sealed: true } : this.view()));
    return new Response(null, { status: 101, webSocket: client });
  }

  // The socket only ever receives. Anything but the auto-answered ping is ignored.
  webSocketMessage() {}

  webSocketClose(ws: WebSocket, code: number) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code); } catch { /* already closed */ }
  }
}

/** How a session reads in one line, for get_board and refused claims. */
export function describeSession(s: Session | null, now: number): string {
  if (!s) return "a session that hasn't reported";
  const ago = Math.max(0, Math.round((now - s.seenAt) / 1000));
  const seen = ago < 90 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;
  const where = `${known(s.machine) ? ` on ${s.machine}` : ""}${known(s.project) ? ` in ${s.project}` : ""}`;
  // "needs input" alone reads like a stuck terminal; with the line it says what it's waiting on.
  const state = s.state === "needs-input" && s.last ? `needs input (${s.last})` : s.state.replace("-", " ");
  return `${s.agent || "agent"}${where}, ${state}, seen ${seen} (session ${s.id})`;
}
