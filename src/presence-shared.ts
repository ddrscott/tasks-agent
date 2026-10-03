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
