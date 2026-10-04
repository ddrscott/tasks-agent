// The shapes the browser and the Presence object (presence.ts) share. Kept in a file of its own
// so the client bundle never pulls in the Durable Object.

export type SessionState = "working" | "needs-input" | "idle";

export type Session = {
  id: string;
  project: string;
  machine: string;
  /** What kind of agent it is, like "lead", when the session says. */
  agent: string;
  state: SessionState;
  /** One line: the last tool, or what it's waiting on. */
  last: string;
  /** The folder it runs in, so `cd <cwd> && claude --resume <id>` can be copied. */
  cwd: string;
  /** A Remote Control link, when the session sent one. */
  link: string;
  startedAt: number;
  seenAt: number;
};

export type Claim = { cardId: string; sessionId: string; agent: string; claimedAt: number };

export type PresenceView = { sessions: Session[]; claims: Claim[]; now: number };

/** After this long without a report, the panel marks a session stale. */
export const STALE_MS = 5 * 60 * 1000;

export const isStale = (s: Session, now: number) => now - s.seenAt > STALE_MS;

/** A project or machine nobody told us. Older rows hold the word "unknown"; newer ones hold nothing. */
export const known = (v: string) => (v && v !== "unknown" ? v : "");

/** The heading a session is listed under. */
export const projectName = (s: Pick<Session, "project">) => known(s.project) || "No project";

/** Who and where, in a few words: "lead · mac-studio", "lead", "mac-studio", or just "agent". */
export const whoWhere = (s: Pick<Session, "agent" | "machine">, agent = s.agent) =>
  [agent, known(s.machine)].filter(Boolean).join(" · ") || "agent";

// ── What's waiting on you ────────────────────────────────────────────────────────────────────

/** As much of a card as the count needs. */
type Asked = { id: string; ask?: unknown };

/**
 * The session behind a card's open question, when that session is itself stopped at a prompt.
 * That's one decision, not two: it shows as the question, with the session under it.
 */
export function askingSession(card: Asked, sessions: Session[], claims: Claim[], now: number): Session | null {
  if (!card.ask) return null;
  const claim = claims.find((c) => c.cardId === card.id);
  const s = claim && sessions.find((x) => x.id === claim.sessionId);
  return s && s.state === "needs-input" && !isStale(s, now) ? s : null;
}

/**
 * The sessions that are stopped until you do something, longest wait first. They count in the top
 * bar's "need you" with the open questions. Two kinds are left out. Stale ones: a session that's
 * been quiet for 5 minutes is as likely closed as waiting, and Claude Code's "waiting for your
 * input" notice puts every finished session in this state after a minute. And a session holding
 * the claim on a card with an open question: the question already counts, and it's the same decision.
 */
export function blockedSessions(sessions: Session[], now: number, claims: Claim[], cards: Asked[]): Session[] {
  const asked = new Set(cards.filter((c) => c.ask).map((c) => c.id));
  const counted = new Set(claims.filter((c) => asked.has(c.cardId)).map((c) => c.sessionId));
  return sessions
    .filter((s) => s.state === "needs-input" && !isStale(s, now) && !counted.has(s.id))
    .sort((a, b) => a.seenAt - b.seenAt);
}

/** The top bar's "N need you": every open question, plus every blocked session that isn't behind one of them. */
export const needYouCount = (cards: Asked[], p: { sessions: Session[]; claims: Claim[]; now: number }) =>
  cards.filter((c) => c.ask).length + blockedSessions(p.sessions, p.now, p.claims, cards).length;

// ── Sessions that only claim ─────────────────────────────────────────────────────────────────
// An agent with no hooks (Cursor, Codex, anything that only speaks MCP) is heard from through
// claim_card and release_card alone. Its row is written from these rules, so it says what the
// agent last did and never sits at "working" with nothing claimed.

/** The part of a row a claim or release can change. */
export type ClaimRow = Pick<Session, "project" | "machine" | "agent" | "state" | "last">;
type Said = { agent?: string; machine?: string; project?: string };

const named = (title: string) => (title ? `"${title}"` : "a card");

/**
 * The row after claim_card. `won` is whether it got the card; `holds` is how many cards the
 * session holds once the call is done. What the agent says about itself replaces what it said before.
 */
export function afterClaim(prev: ClaimRow | null, said: Said, title: string, won: boolean, holds: number): ClaimRow {
  return {
    project: said.project || prev?.project || "",
    machine: said.machine || prev?.machine || "",
    agent: said.agent || prev?.agent || "",
    state: holds > 0 ? "working" : "idle",
    last: won ? `claimed ${named(title)}` : `asked for ${named(title)}, which another session holds`,
  };
}

/** The row after release_card gave a card back. `holds` is how many it still has. */
export function afterRelease(prev: ClaimRow, title: string, holds: number): ClaimRow {
  return { ...prev, state: holds > 0 ? "working" : "idle", last: `released ${named(title)}` };
}

// ── A claimed card that's finished or gone ───────────────────────────────────────────────────
// A claim says "a session is working on this". A card in the last lane is done and a deleted
// card is gone, so neither can be worked on, whoever moved it. The board (agent.ts) spots those
// cards with endedCards on every change, undo and redo included, and Presence drops their claims.

/** As much of a board as the rule needs. */
type LanesAndCards = { lanes: { id: string; name: string }[]; cards: { id: string; laneId: string; title: string }[] };

/** A card whose claim is over: it reached the last lane (`lane` is that lane's name) or was deleted. */
export type Ended = { cardId: string; title: string; how: "done" | "deleted"; lane: string; by: "you" | "agent" };

/**
 * The cards a change finished or removed. "Finished" is being in the last lane now and not
 * before, so dragging a card there counts, and so does a lane change that makes its lane the
 * last one. A card that was already there, or a board with one lane, is left alone.
 */
export function endedCards(before: LanesAndCards, after: LanesAndCards, by: Ended["by"]): Ended[] {
  if (before.cards === after.cards && before.lanes === after.lanes) return [];
  const lastBefore = before.lanes.length > 1 ? before.lanes[before.lanes.length - 1].id : null;
  const last = after.lanes.length > 1 ? after.lanes[after.lanes.length - 1] : null;
  const now = new Map(after.cards.map((c) => [c.id, c]));
  const was = new Map(before.cards.map((c) => [c.id, c]));
  const out: Ended[] = [];
  for (const c of before.cards) {
    if (!now.has(c.id)) out.push({ cardId: c.id, title: c.title, how: "deleted", lane: "", by });
  }
  if (last) {
    for (const c of after.cards) {
      if (c.laneId !== last.id) continue;
      const old = was.get(c.id);
      if (old && old.laneId === lastBefore) continue;
      out.push({ cardId: c.id, title: c.title, how: "done", lane: last.name, by });
    }
  }
  return out;
}

/**
 * The row of a session that only claims, after a card it held was finished or deleted. `holds`
 * is how many cards it still has. An agent that moved the card itself "finished" it; when the
 * person did, the line says what happened to the card instead of crediting the session.
 */
export function afterEnded(prev: ClaimRow, e: Pick<Ended, "title" | "how" | "lane" | "by">, holds: number): ClaimRow {
  const last = e.how === "deleted" ? `${named(e.title)} was deleted`
    : e.by === "agent" ? `finished ${named(e.title)}`
    : `${named(e.title)} was moved to ${e.lane || "the last lane"}`;
  return { ...prev, state: holds > 0 ? "working" : "idle", last };
}

/** What a row says once its claims ran out because the session stopped renewing them. */
export const LAPSED = "its claim lapsed";
