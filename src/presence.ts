// Which cards agent sessions have claimed.
//
// A lead agent claims a card with its session id over MCP (claim_card in mcp.ts). One Durable
// Object per user, and the object is single-threaded, so two leads can't both win a card. A claim
// holds while its session is heard from and is free again 15 minutes after it goes quiet.
//
// "Heard from" is the session's MCP calls and nothing else: claim_card, release_card, ask_ceo,
// and wait_for_answer. Each claim row carries when its session was last heard from, and that's
// the whole record of a session. Nothing here knows a machine, a folder, or a running process;
// watching what an agent is doing is another tool's job.
//
// Kept apart from the board on purpose. Nothing here goes through TodoAgent.mutate, so a claim
// can't add an undo step, flash a card, or reindex search.
//
// The class is still called Presence because that's the name boards in production have their
// claims stored under (wrangler.jsonc). It used to hold a row per Claude Code session as well,
// fed by hooks; the constructor drops what's left of that.

import { DurableObject } from "cloudflare:workers";

import type { Claim, ClaimsView } from "./presence-shared";

export type { Claim, ClaimsView };

/** A claim holds this long after its session was last heard from, so a lead that's thinking keeps its card. */
export const CLAIM_LIVE_MS = 15 * 60 * 1000;

const SESSION_ID = /^[\w.:-]{6,80}$/;

const clean = (v: unknown, max: number) =>
  (typeof v === "string" ? v : "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

type Row = { card_id: string; session_id: string; agent: string; claimed_at: number; seen_at: number };

export class Presence extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS claims (
      card_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent TEXT NOT NULL, claimed_at INTEGER NOT NULL)`);
    // seen_at: when the claim's session was last heard from. It used to live on a row per session.
    // A claim made before this column takes its session's time from that row, so it doesn't lapse
    // or get a fresh 15 minutes just because the code changed.
    try {
      this.sql.exec("ALTER TABLE claims ADD COLUMN seen_at INTEGER NOT NULL DEFAULT 0");
      try {
        this.sql.exec("UPDATE claims SET seen_at = COALESCE((SELECT seen_at FROM sessions WHERE sessions.id = claims.session_id), 0)");
      } catch { /* a new object: there never was a sessions table */ }
    } catch { /* the column is already there */ }
    // What Sessions stored and claims don't need: folder paths, machines, projects, last-action
    // lines, the question a session was waiting on, and which user the object belongs to.
    this.sql.exec("DROP TABLE IF EXISTS sessions");
    this.sql.exec("DROP TABLE IF EXISTS meta");
    for (const column of ["asked", "asked_at"]) {
      try { this.sql.exec(`ALTER TABLE claims DROP COLUMN ${column}`); } catch { /* never added, or already gone */ }
    }
  }

  /** Erase everything. Called when a board turns encryption on: an encrypted board is closed to agents, so it holds no claims. */
  wipe() {
    this.sql.exec("DELETE FROM claims");
  }

  /** A claim whose session has been quiet too long is free again. */
  private expire(now: number) {
    this.sql.exec("DELETE FROM claims WHERE seen_at < ?", now - CLAIM_LIVE_MS);
  }

  /** The session was heard from: every claim it holds gets the new time. One that holds nothing has nothing to move. */
  private heard(sessionId: string, now: number) {
    this.sql.exec("UPDATE claims SET seen_at = ? WHERE session_id = ?", now, sessionId);
  }

  private held(cardId: string): Row | undefined {
    return this.sql.exec("SELECT * FROM claims WHERE card_id = ?", cardId).toArray()[0] as unknown as Row | undefined;
  }

  /** The agent kind a session gave on a card it still holds, when it said. */
  private agentOf(sessionId: string): string {
    return (this.sql.exec("SELECT agent FROM claims WHERE session_id = ? AND agent != 'agent' LIMIT 1", sessionId).toArray()[0]?.agent as string | undefined) ?? "";
  }

  /** The live claims, oldest first, for get_board. */
  view(): ClaimsView {
    const now = Date.now();
    this.expire(now);
    const claims = (this.sql.exec("SELECT * FROM claims ORDER BY claimed_at").toArray() as unknown as Row[]).map(toClaim);
    return { claims, now };
  }

  /**
   * Claim a card for a session. Refused while another live session holds it. Either way the
   * session was heard from, so the cards it already holds stay its own.
   */
  claim(input: { cardId: string; sessionId: string; agent?: string }): { ok: true; claim: Claim } | { ok: false; holder: Claim } {
    const now = Date.now();
    const cardId = clean(input.cardId, 40);
    const sessionId = clean(input.sessionId, 80);
    this.expire(now);
    // One name per session: what it says now, else what it said on a card it still holds. A claim
    // that leaves agent off doesn't turn "cursor" into "agent".
    const said = clean(input.agent, 40);
    const agent = said || this.agentOf(sessionId) || "agent";
    const held = this.held(cardId);
    // expire() already dropped claims of quiet sessions, so a holder that's left is live.
    if (held && held.session_id !== sessionId) {
      this.heard(sessionId, now);
      return { ok: false, holder: toClaim(held) };
    }
    this.sql.exec(
      `INSERT INTO claims (card_id, session_id, agent, claimed_at, seen_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(card_id) DO UPDATE SET session_id = excluded.session_id, agent = excluded.agent`,
      cardId, sessionId, agent, held?.claimed_at ?? now, now,
    );
    if (said) this.sql.exec("UPDATE claims SET agent = ? WHERE session_id = ?", said, sessionId);
    this.heard(sessionId, now);
    return { ok: true, claim: { cardId, sessionId, agent, claimedAt: held?.claimed_at ?? now, seenAt: now } };
  }

  /**
   * A session asked a question on a card (ask_ceo in mcp.ts). A card waiting on its owner isn't
   * up for grabs, so the asker keeps it: if the call named a session and nobody holds the card,
   * asking claims it. Returns the session holding the card for the asker, or null when there's
   * none: the call named no session and the card was unclaimed, or another live session has it
   * (the question still stands on the card, and the caller was heard from).
   */
  asked(input: { cardId: string; sessionId?: string }): string | null {
    const now = Date.now();
    const cardId = clean(input.cardId, 40);
    const named = clean(input.sessionId, 80);
    const valid = SESSION_ID.test(named);
    this.expire(now);
    const held = this.held(cardId);
    if (valid) this.heard(named, now);
    if (!held) {
      if (!valid) return null;
      this.sql.exec("INSERT INTO claims (card_id, session_id, agent, claimed_at, seen_at) VALUES (?, ?, ?, ?, ?)",
        cardId, named, this.agentOf(named) || "agent", now, now);
      return named;
    }
    if (named && held.session_id !== named) return null;
    // No session named: the asker is whoever holds the card, which is the agent that claimed first, as the rules have it.
    this.heard(held.session_id, now);
    return held.session_id;
  }

  /**
   * An MCP call that isn't a claim still says its session is alive: wait_for_answer most of all,
   * since an agent polling for an answer makes no other call. Moves the last-heard time of the
   * sessions named, and of the sessions holding the cards named, and nothing else.
   */
  touch(input: { sessionIds?: string[]; cardIds?: string[] }) {
    const now = Date.now();
    this.expire(now);
    const ids = new Set((input.sessionIds ?? []).map((id) => clean(id, 80)).filter(Boolean));
    for (const cardId of input.cardIds ?? []) {
      const c = this.held(clean(cardId, 40));
      if (c) ids.add(c.session_id);
    }
    for (const id of ids) this.heard(id, now);
  }

  /** Give a card back. Only the session holding it can. Releasing counts as hearing from it, for the cards it keeps. */
  release(input: { cardId: string; sessionId: string }): boolean {
    const now = Date.now();
    const cardId = clean(input.cardId, 40);
    const sessionId = clean(input.sessionId, 80);
    this.expire(now);
    const released = this.sql.exec("DELETE FROM claims WHERE card_id = ? AND session_id = ?", cardId, sessionId).rowsWritten > 0;
    if (released) this.heard(sessionId, now);
    return released;
  }

  /**
   * Cards that just reached the done lane or were deleted (endedCards in presence-shared.ts; the
   * board calls this from TodoAgent.mutate and from undo and redo). Their claims are over: nothing
   * is working on a card that's done or gone. Nobody was heard from here, so no last-heard time moves.
   */
  finish(cardIds: string[]) {
    for (const id of cardIds) this.sql.exec("DELETE FROM claims WHERE card_id = ?", clean(id, 40));
  }

  // Objects that held session rows may still have an alarm set from then. It has nothing to do.
  alarm() {}
}

const toClaim = (r: Row): Claim => ({ cardId: r.card_id, sessionId: r.session_id, agent: r.agent, claimedAt: r.claimed_at, seenAt: r.seen_at });

/** Who holds a card in one line, for get_board and refused claims. */
export function describeHolder(c: Claim, now: number): string {
  const ago = Math.max(0, Math.round((now - c.seenAt) / 1000));
  return `${c.agent || "agent"}, heard from ${ago < 90 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`} (session ${c.sessionId})`;
}
