// The shapes the browser and the Presence object (presence.ts) share. Kept in a file of its own
// so the client bundle never pulls in the Durable Object.

import { doneLaneId, type RoleLane } from "./lanes";

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

export type Claim = {
  cardId: string; sessionId: string; agent: string; claimedAt: number;
  /** The question this session asked on the card (ask_ceo), while it's open. Gone once it's answered or taken back. */
  asked?: string;
  askedAt?: number;
};

export type PresenceView = { sessions: Session[]; claims: Claim[]; now: number };

/** After this long without a report, the panel marks a session stale. */
export const STALE_MS = 5 * 60 * 1000;

export const isStale = (s: Session, now: number) => now - s.seenAt > STALE_MS;

/**
 * Whether a session counts in "N live sessions". Stale ones don't. Neither does an idle session
 * that only ever spoke MCP (no folder, so no hooks): it holds no card and waits on nothing, and
 * with no hooks nothing says its agent is still running. A one-shot agent that released its last
 * card and exited would otherwise sit in the count for five more minutes.
 */
export const isLive = (s: Session, now: number) => !isStale(s, now) && !(s.state === "idle" && !s.cwd);

/** A project or machine nobody told us. Older rows hold the word "unknown"; newer ones hold nothing. */
export const known = (v: string) => (v && v !== "unknown" ? v : "");

/** The heading a session is listed under. */
export const projectName = (s: Pick<Session, "project">) => known(s.project) || "No project";

/** Who and where, in a few words: "lead · mac-studio", "lead", "mac-studio", or just "agent". */
export const whoWhere = (s: Pick<Session, "agent" | "machine">, agent = s.agent) =>
  [agent, known(s.machine)].filter(Boolean).join(" · ") || "agent";

// ── A session that asked ─────────────────────────────────────────────────────────────────────
// A session with a question open is waiting on you, whatever its last tool call was. Its row
// keeps what hooks or claims wrote underneath, and reads like this for as long as the question
// is open. Presence.view applies it, and so do the demo and the front page's sample board.

/** What a waiting session's row says in place of its last action. */
export const askedLine = (question: string) => `asked: ${question}`;

/** The sessions as they read: one with a question open says needs input and the question (its newest, with several). */
export function withAsks(sessions: Session[], claims: Claim[]): Session[] {
  const newest = new Map<string, Claim>();
  for (const c of claims) {
    if (!c.asked) continue;
    const had = newest.get(c.sessionId);
    if (!had || (c.askedAt ?? 0) >= (had.askedAt ?? 0)) newest.set(c.sessionId, c);
  }
  if (!newest.size) return sessions;
  return sessions.map((s) => {
    const c = newest.get(s.id);
    return c ? { ...s, state: "needs-input" as const, last: askedLine(c.asked!).slice(0, 250) } : s;
  });
}

/** How long a question has been open, for the line under it: "waiting 40s", "waiting 4m", "waiting 2h". */
export function waitingFor(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `waiting ${s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`}`;
}

// ── What's waiting on you ────────────────────────────────────────────────────────────────────

/** As much of a card as the count needs. */
type Asked = { id: string; ask?: unknown };

/**
 * The session behind a card's open question: the one holding the card that's stopped until you
 * answer, which is the session that asked (withAsks). That's one decision, not two: it shows as
 * the question, with the session under it. A stale one is still shown, marked stale, since
 * "nobody is listening for this answer anymore" is worth knowing before you tap.
 */
export function askingSession(card: Asked, sessions: Session[], claims: Claim[]): Session | null {
  if (!card.ask) return null;
  const claim = claims.find((c) => c.cardId === card.id);
  const s = claim && sessions.find((x) => x.id === claim.sessionId);
  return s && s.state === "needs-input" ? s : null;
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

/**
 * The row under a session that just asked a question (ask_ceo). It keeps the card, so it's still
 * working underneath; while the question is open the row reads needs input instead (withAsks).
 */
export function afterAsk(prev: ClaimRow | null, title: string, holds: number): ClaimRow {
  return {
    project: prev?.project ?? "", machine: prev?.machine ?? "", agent: prev?.agent ?? "",
    state: holds > 0 ? "working" : "idle",
    last: `asked a question on ${named(title)}`,
  };
}

/** A card whose question just closed: you answered it, or it was taken off the card with no answer. */
export type Settled = { cardId: string; title: string; how: "answered" | "withdrawn" };

/** As much of a board as that rule needs. */
type AskedCards = { cards: { id: string; title: string; ask?: unknown; answer?: { at: string } }[] };

/**
 * The questions a change closed. A card that had one and now has none: answered when the card
 * carries a new answer, withdrawn otherwise (#needs-ceo taken off by hand, or the ask undone). A
 * deleted card isn't here; endedCards has it. A question replaced by another is still open.
 */
export function settledAsks(before: AskedCards, after: AskedCards): Settled[] {
  if (before.cards === after.cards) return [];
  const now = new Map(after.cards.map((c) => [c.id, c]));
  const out: Settled[] = [];
  for (const c of before.cards) {
    const next = now.get(c.id);
    if (!c.ask || !next || next.ask) continue;
    out.push({ cardId: c.id, title: next.title, how: next.answer && next.answer.at !== c.answer?.at ? "answered" : "withdrawn" });
  }
  return out;
}

/**
 * The row of a session that only claims, once its question closed. It still holds the card, so
 * it's working again; nobody was heard from, so its last-seen time doesn't move.
 */
export function afterSettled(prev: ClaimRow, e: Pick<Settled, "title" | "how">, holds: number): ClaimRow {
  return {
    ...prev,
    state: holds > 0 ? "working" : "idle",
    last: e.how === "answered" ? `got your answer on ${named(e.title)}` : `its question on ${named(e.title)} was taken back`,
  };
}

/** The row after release_card gave a card back. `holds` is how many it still has. */
export function afterRelease(prev: ClaimRow, title: string, holds: number): ClaimRow {
  return { ...prev, state: holds > 0 ? "working" : "idle", last: `released ${named(title)}` };
}

// ── A claimed card that's finished or gone ───────────────────────────────────────────────────
// A claim says "a session is working on this". A card in the done lane (lanes.ts) is done and a deleted
// card is gone, so neither can be worked on, whoever moved it. The board (agent.ts) spots those
// cards with endedCards on every change, undo and redo included, and Presence drops their claims.

/** As much of a board as the rule needs. */
type LanesAndCards = { lanes: RoleLane[]; cards: { id: string; laneId: string; title: string }[] };

/** A card whose claim is over: it reached the done lane (`lane` is that lane's name) or was deleted. */
export type Ended = { cardId: string; title: string; how: "done" | "deleted"; lane: string; by: "you" | "agent" };

/**
 * The cards a change finished or removed. "Finished" is being in the done lane now and not
 * before, so dragging a card there counts, and so does making its lane the done lane. Moving
 * the lanes around finishes nothing. A card that was already there, or a board with no done
 * lane, is left alone.
 */
export function endedCards(before: LanesAndCards, after: LanesAndCards, by: Ended["by"]): Ended[] {
  if (before.cards === after.cards && before.lanes === after.lanes) return [];
  const lastBefore = doneLaneId(before.lanes);
  const doneNow = doneLaneId(after.lanes);
  const last = after.lanes.find((l) => l.id === doneNow) ?? null;
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
    : `${named(e.title)} was moved to ${e.lane || "the done lane"}`;
  return { ...prev, state: holds > 0 ? "working" : "idle", last };
}

/** What a row says once its claims ran out because the session stopped renewing them. */
export const LAPSED = "its claim lapsed";
