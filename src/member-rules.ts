// The rules for team boards, with nothing in them but logic: who gets what role, what a member
// may call, and what a member's change may touch. src/members.ts feeds them from D1, and
// src/agent.ts enforces them inside the board's Durable Object. `npm run check:members` runs
// them on their own.

import { doneLaneId } from "./lanes";
import type { Board, Card } from "./shared";

/** What an invite grants. The owner isn't a member: they're whoever the board's Durable Object is named after. */
export type MemberRole = "viewer" | "writer";
export type Role = "owner" | MemberRole;
/** What the role is worth right now. "none" means no way in at all. */
export type Effective = Role | "none";
/**
 * Why `effective` is less than `role`:
 * - `plan_lapsed`: the owner isn't on Pro, so members can look and not touch.
 * - `encrypted`: the board is end-to-end encrypted, which closes it to everyone but the owner.
 * - `not_member`: no accepted invite. Also what a board that doesn't exist says.
 */
export type AccessReason = null | "plan_lapsed" | "encrypted" | "not_member";

export type Access = {
  /** The board's id, which is its owner's user id. Not a secret: the membership check is the lock. */
  board: string;
  /** Null unless the caller is the owner or an accepted member. */
  ownerEmail: string | null;
  role: Role | null;
  effective: Effective;
  reason: AccessReason;
  /** The owner's plan. Always "free" when the caller has no way in, so it says nothing about the board. */
  plan: "free" | "pro";
};

export const BOARD_ID = /^[0-9a-f]{32}$/;

/** The one decision: a role and what it's worth, from who's asking, the owner's plan, and whether the board is encrypted. */
export function decide(input: { isOwner: boolean; membership: MemberRole | null; plan: "free" | "pro"; sealed: boolean }): Pick<Access, "role" | "effective" | "reason"> {
  if (input.isOwner) return { role: "owner", effective: "owner", reason: null };
  if (input.membership !== "viewer" && input.membership !== "writer") return { role: null, effective: "none", reason: "not_member" };
  if (input.sealed) return { role: input.membership, effective: "none", reason: "encrypted" };
  if (input.plan !== "pro") return { role: input.membership, effective: "viewer", reason: "plan_lapsed" };
  return { role: input.membership, effective: input.membership, reason: null };
}

/**
 * Everything a member's connection may call on the board, and the least role that may call it.
 * A callable that isn't listed here is the owner's, which is how a new one starts out.
 */
export const MEMBER_CALLS: Readonly<Record<string, MemberRole>> = Object.freeze({
  search: "viewer",
  addCard: "writer",
  updateCard: "writer",
  moveCard: "writer",
  deleteCard: "writer",
  removeAttachment: "writer",
  applyLocal: "writer",
});

/** The role a member needs for `method`, or null when it's the owner's alone. */
export function memberCallNeeds(method: unknown): MemberRole | null {
  return typeof method === "string" && Object.hasOwn(MEMBER_CALLS, method) ? MEMBER_CALLS[method] : null;
}

export const OWNER_ONLY = "Only the board's owner can do that.";
export const READ_ONLY = "You can view this board, not change it.";
export const READ_ONLY_LAPSED = "This board is view only until its owner's Pro plan is back.";

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Why a writer's change is refused, or null when it's allowed. A writer changes cards and
 * nothing else, so this compares the board before and after instead of trusting which action
 * was called: lanes (names, order, sort, roles), the theme, encryption, and every other board
 * setting have to come out identical, and a question on a card stays the owner's to answer or
 * take back. It runs on every change a member makes, whatever path it took.
 */
export function memberChangeError(before: Board, after: Board): string | null {
  const { cards: _b, ...restBefore } = before;
  const { cards: _a, ...restAfter } = after;
  if (!same(restBefore, restAfter)) return OWNER_ONLY;
  const was = new Map(before.cards.map((c) => [c.id, c]));
  const now = new Map(after.cards.map((c) => [c.id, c]));
  const done = doneLaneId(after.lanes);
  for (const c of after.cards) {
    const p: Card | undefined = was.get(c.id);
    // A question is asked by an agent and answered by the owner. A member's change can't add,
    // edit, answer, or clear one, and can't rewrite the last answer either.
    if (!same(p?.ask, c.ask) || !same(p?.answer, c.answer)) return "Questions on a card are the board owner's to answer.";
    // Finishing a card with its question still open ends the agent's wait, the same as taking the question back.
    if (c.ask && done && c.laneId === done && p?.laneId !== done) return "That card has a question waiting on the board's owner.";
  }
  for (const p of before.cards) {
    if (p.ask && !now.has(p.id)) return "That card has a question waiting on the board's owner.";
  }
  return null;
}

/** Throws unless a caller with this effective role may turn `before` into `after`. The owner may do anything. */
export function assertMayChange(effective: Effective, reason: AccessReason, before: Board, after: Board): void {
  if (effective === "owner") return;
  if (effective !== "writer") throw new Error(reason === "plan_lapsed" ? READ_ONLY_LAPSED : READ_ONLY);
  const why = memberChangeError(before, after);
  if (why) throw new Error(why);
}

/**
 * How an invited address is written down. Lower-cased and trimmed, the same as sign-in does it
 * (normalizeEmail in auth.ts), because the account id is a hash of that exact string: an invite
 * normalized any other way would never match the person who signs in.
 *
 * - Plus addressing is kept. `a+x@example.com` and `a@example.com` sign in as two accounts, and
 *   only some mail hosts treat them as one mailbox, so folding them would hand an invite to
 *   whoever controls the other form.
 * - Only plain ASCII is accepted. A look-alike letter (Cyrillic "а" for "a") makes an address
 *   that reads the same in the members list and belongs to someone else. Refusing them costs
 *   internationalized addresses, which can be allowed later with a visible warning.
 */
export function inviteEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[\x21-\x7e]+$/.test(email)) return null;
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email) ? email : null;
}

export const isMemberRole = (v: unknown): v is MemberRole => v === "viewer" || v === "writer";

// Headers the Worker sets when it hands a request to a board's Durable Object. They mean
// something only because the Worker is the one who set them: it deletes every one of these
// from what the browser sent before adding its own (INTERNAL_HEADERS, server.ts).
/** The signed-in user's id. The board answers its own SDK protocol only when this is its owner. */
export const H_USER = "x-tasks-user";
/** The signed-in user's email, for attribution. */
export const H_EMAIL = "x-tasks-email";
/** `{"id","email"}` of a member the Worker has checked. Its presence picks the member protocol. */
export const H_MEMBER = "x-tasks-member";
export const INTERNAL_HEADERS = [
  H_USER, H_EMAIL, H_MEMBER, "x-user",
  // The Agents SDK's own: startup props, and the marker that routes a socket to a sub-agent.
  "x-agents-lifecycle-props", "x-cf-agents-subagent-url",
] as const;

/** The frame a member's socket gets on connect and whenever its access changes. */
export type AccessFrame = { type: "tasks_access" } & Access & {
  /** Set on the last frame before the socket is closed. */
  closed?: "removed" | "encrypted";
};
/** WebSocket close code for a member who lost the board. */
export const CLOSE_NO_ACCESS = 4403;
