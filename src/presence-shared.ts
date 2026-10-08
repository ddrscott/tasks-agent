// The claim shapes and the one board rule about claims, apart from the Presence object
// (presence.ts) so the board and the checks can use them without pulling in a Durable Object.

import { doneLaneId, type RoleLane } from "./lanes";

export type Claim = {
  cardId: string; sessionId: string;
  /** What kind of agent it is, like "cursor", when the session said. "agent" when it didn't. */
  agent: string;
  claimedAt: number;
  /** When the session was last heard from: its last claim_card, release_card, ask_ceo, or wait_for_answer. */
  seenAt: number;
};

export type ClaimsView = { claims: Claim[]; now: number };

// ── A claimed card that's finished or gone ───────────────────────────────────────────────────
// A claim says "a session is working on this". A card in the done lane (lanes.ts) is done and a deleted
// card is gone, so neither can be worked on, whoever moved it. The board (agent.ts) spots those
// cards with endedCards on every change, undo and redo included, and Presence drops their claims.

/** As much of a board as the rule needs. */
type LanesAndCards = { lanes: RoleLane[]; cards: { id: string; laneId: string }[] };

/** A card whose claim is over: it reached the done lane (`lane` is that lane's name) or was deleted. */
export type Ended = { cardId: string; how: "done" | "deleted"; lane: string };

/**
 * The cards a change finished or removed. "Finished" is being in the done lane now and not
 * before, so dragging a card there counts, and so does making its lane the done lane. Moving
 * the lanes around finishes nothing. A card that was already there, or a board with no done
 * lane, is left alone.
 */
export function endedCards(before: LanesAndCards, after: LanesAndCards): Ended[] {
  if (before.cards === after.cards && before.lanes === after.lanes) return [];
  const lastBefore = doneLaneId(before.lanes);
  const doneNow = doneLaneId(after.lanes);
  const last = after.lanes.find((l) => l.id === doneNow) ?? null;
  const now = new Map(after.cards.map((c) => [c.id, c]));
  const was = new Map(before.cards.map((c) => [c.id, c]));
  const out: Ended[] = [];
  for (const c of before.cards) {
    if (!now.has(c.id)) out.push({ cardId: c.id, how: "deleted", lane: "" });
  }
  if (last) {
    for (const c of after.cards) {
      if (c.laneId !== last.id) continue;
      const old = was.get(c.id);
      if (old && old.laneId === lastBefore) continue;
      out.push({ cardId: c.id, how: "done", lane: last.name });
    }
  }
  return out;
}
