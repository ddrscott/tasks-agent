// The rules for team boards, with nothing in them but logic: who gets what role, what a member
// may call, and what a member's change may touch. src/members.ts feeds them from D1, and
// src/agent.ts enforces them inside the board's Durable Object. `npm run check:members` runs
// them on their own.

import { doneLaneId } from "./lanes";
import { AGENT_TAG, cleanTag, forAgent, GAUNTLET_TAG, NEEDS_CEO_TAG, SHIP_OK_TAG, type Board, type Card } from "./shared";

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
  addCards: "writer",
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

// ---------- how much a member may send, and how big they may make the board ----------

/**
 * Every frame a member's socket sends costs one token from a bucket kept per member (not per
 * socket, so more tabs don't mean more room). The bucket holds `burst` and refills at
 * `perSecond`: a person dragging cards and ticking boxes never gets near it, and a script gets
 * `burst` calls and then `perSecond` a second. A frame that finds the bucket empty is refused
 * with SLOW_DOWN. `strikes` refusals without the bucket ever refilling to full is a flood, and
 * the socket that sent the last one is closed (CLOSE_FLOOD).
 */
export const MEMBER_RATE = { burst: 40, perSecond: 4, strikes: 100, /** A frame costs one token, plus one for every this many bytes of it. */ bytesPerToken: 2048 } as const;
export type Bucket = { tokens: number; at: number; strikes: number };

/**
 * What a frame of `bytes` costs. A drag, a tick, or a typed card is one token. A frame that
 * carries a lot of text costs more, so the bucket limits how fast a member can grow the board
 * and not only how often they can call it: the biggest notes a card takes (12 KB) are 6 or 7
 * tokens, which is one such write every second and a half once the burst is spent.
 */
export const frameCost = (bytes: number) => 1 + Math.floor(Math.max(0, bytes) / MEMBER_RATE.bytesPerToken);

/** Take `cost` tokens. `ok` is whether the frame may run; `flood` is whether to close the socket. Mutates and returns the bucket. */
export function spendToken(b: Bucket | undefined, now: number, rate: { burst: number; perSecond: number; strikes: number } = MEMBER_RATE, cost = 1): { bucket: Bucket; ok: boolean; flood: boolean } {
  const bucket = b ?? { tokens: rate.burst, at: now, strikes: 0 };
  bucket.tokens = Math.min(rate.burst, bucket.tokens + (Math.max(0, now - bucket.at) / 1000) * rate.perSecond);
  bucket.at = now;
  // Quiet for long enough to fill up again: whatever happened before is forgiven.
  if (bucket.tokens >= rate.burst) bucket.strikes = 0;
  if (bucket.tokens >= cost) { bucket.tokens -= cost; return { bucket, ok: true, flood: false }; }
  bucket.strikes += 1;
  return { bucket, ok: false, flood: bucket.strikes >= rate.strikes };
}

/** Errors a member's client treats specially start with a code in brackets, like the board's `[board_shared]`. */
export const errorCode = (message: string) => /^\[([a-z_]+)\]/.exec(message)?.[1] ?? null;
/** The same error without its code, to show a person. */
export const plainError = (message: string) => message.replace(/^\[[a-z_]+\]\s*/, "");
export const SLOW_DOWN = "[slow_down] Slow down. That's too many changes at once. Wait a few seconds and try again.";

/**
 * The most a member may grow someone else's board to. The field sizes in characters are the
 * ones every edit already gets (clean and tidyNotes in shared.ts); here they're checked on the
 * result, so no path a member's change takes can skip them (text that looks encrypted is
 * passed through untrimmed by those, and a shared board is never encrypted).
 *
 * Characters aren't what the board costs to store and send, bytes are, and one character can
 * be six of them: a control character is written `\u0001` in JSON. So a member's text is also
 * held to a size in bytes as it's stored (JSON, UTF-8), and control characters other than a
 * newline and a tab are refused outright (`jsonBytes`, `CONTROL` below).
 *
 * `cards` and `boardBytes` are ceilings on growth only: on a board already over one, a member
 * can still edit, move, and delete, and can't add. `boardBytes` is well under the 2 MB row the
 * board's Durable Object stores it in, so a member can never fill what the owner has left.
 */
export const MEMBER_LIMITS = {
  title: 200, notes: 4000, tags: 10, tag: 32,
  /** A title as stored: 200 characters of any script (3 bytes each at most for one UTF-16 unit). */
  titleBytes: 600,
  /** Notes as stored: 4,000 characters of any script, or of quotes and line breaks, which double when escaped. */
  notesBytes: 12 * 1024,
  /** One card as stored, files and all: the biggest notes, 20 files, and tags. */
  cardBytes: 32 * 1024,
  cards: 1000,
  /** The whole board as stored, in bytes. A member can't push it past this; the owner has the rest of the 2 MB row. */
  boardBytes: 768 * 1024,
  /** Cards one member may delete in a UTC day. Each is a row in the owner's audit log, which nothing prunes. */
  deletesPerDay: 200,
} as const;

const utf8 = new TextEncoder();
/** How many bytes a value takes as the board stores and sends it: JSON, in UTF-8. */
export const jsonBytes = (v: unknown) => utf8.encode(JSON.stringify(v ?? null)).length;
/** Control characters. A title takes none; notes take a newline and a tab. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_IN_NOTES = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const BAD_TEXT = "[bad_text] Card text can't hold control characters, only letters, numbers, punctuation, spaces, tabs, and line breaks. Take them out and try again.";
/**
 * Text as the app sends it: Windows line ends become plain ones, and control characters other
 * than a newline and a tab are dropped, so what a person pastes is never refused for them.
 */
export const plainText = (s: string) => s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

// ---------- the tags that direct the owner's agents ----------

/**
 * The owner's tags, the one list of them. The owner's agents run on the owner's machine with
 * the owner's privileges, and these tags are how the board tells them what to do: `agent` and
 * `gauntlet` make a card a work order, `needs-ceo` coming off says "the owner answered", and
 * `ship-ok` lets a gauntlet agent merge and deploy. So a member, writer or viewer, can't put
 * one on a card or take one off, by any path, and can't change, move, delete, or attach to a
 * card that carries `agent` or `gauntlet`. The write guard below enforces it, and the app
 * reads this list to leave those controls out for a member.
 */
export const OWNER_TAGS: readonly string[] = [AGENT_TAG, GAUNTLET_TAG, NEEDS_CEO_TAG, SHIP_OK_TAG];
export const isOwnerTag = (tag: string) => OWNER_TAGS.includes(tag);
/** A card that's a work order for the owner's agents (`agent` or `gauntlet`): read only to members. */
export const isAgentCard = (c: Pick<Card, "tags">) => forAgent(c as Card);
/** Which owner tag a member is trying to add or remove between two versions of a card, if any. */
function ownerTagChanged(p: Card | undefined, c: Card): string | null {
  return OWNER_TAGS.find((t) => !!p?.tags?.includes(t) !== !!c.tags?.includes(t)) ?? null;
}
/**
 * An owner tag typed at the end of a title ("Do evil #agent"), the way quick add reads tags.
 * It isn't a tag there, but it looks like one that took, so a member's title can't end in it.
 */
export function ownerTagInTitle(title: string): string | null {
  const words = title.trim().split(/\s+/);
  while (words.length > 1) {
    const w = words.pop()!;
    if (!/^#[\p{L}\p{N}_-]{1,32}$/u.test(w)) return null;
    if (isOwnerTag(cleanTag(w))) return cleanTag(w);
  }
  return null;
}
export const ownerTagError = (tag: string) =>
  `[owner_tag] Only the board's owner can put #${tag} on a card or take it off. The owner's agents take their orders from that tag.`;
export const AGENT_CARD = "[agent_card] That card is a work order for the owner's agents (it's tagged #agent or #gauntlet). Only the board's owner can change, move, or delete it.";

/** Why a member can't make this card what it now is, looking at the card alone. `p` is the card before, or undefined for a new one. */
function memberCardError(p: Card | undefined, c: Card): string | null {
  if (p && isAgentCard(p)) return AGENT_CARD;
  const tag = ownerTagChanged(p, c) ?? (typeof c.title === "string" && p?.title !== c.title ? ownerTagInTitle(c.title) : null);
  if (tag) return ownerTagError(tag);
  return cardTooBig(p, c);
}

/** The most cards one `addCards` call takes: a pasted list. A longer paste goes in as several calls. */
export const ADD_CARDS_MAX = 200;

const BOARD_FULL_CARDS = `[board_full] This board has ${MEMBER_LIMITS.cards.toLocaleString("en-US")} cards, the most a member can add to. Delete some, or ask the owner.`;
const BOARD_FULL_BYTES = `[board_full] This board is as big as a member can make it (${MEMBER_LIMITS.boardBytes / 1024} KB of cards). Delete some cards or shorten some notes, or ask the owner.`;

/** What's left under a member's ceilings: how many more cards, and how many more bytes of board. */
export type Room = { cards: number; bytes: number };
export function memberRoom(b: Board): Room {
  return { cards: Math.max(0, MEMBER_LIMITS.cards - b.cards.length), bytes: MEMBER_LIMITS.boardBytes - jsonBytes(b) };
}
/** Room kept for the "who added it" mark the board stamps on a card after this is asked (stampBy). */
const BY_ROOM = 320;

/**
 * Why a member can't add this one new card, or null when there's room, in which case the room
 * it takes is taken. A pasted list (`addCards`) asks this card by card, so the lines that fit
 * land and each line that doesn't is handed back with its reason. The write guard still judges
 * the whole change afterwards; this only says the same thing earlier and one card at a time.
 */
export function takeRoom(room: Room, c: Card): string | null {
  const no = memberCardError(undefined, c);
  if (no) return no;
  if (room.cards < 1) return BOARD_FULL_CARDS;
  const size = jsonBytes(c) + 1 + BY_ROOM;
  if (size > room.bytes) return BOARD_FULL_BYTES;
  room.cards -= 1;
  room.bytes -= size;
  return null;
}

/**
 * Whether a card a member added or changed is over a limit. `p` is the card before, when there
 * was one. The lengths in characters are checked on the whole card. The checks on how text is
 * stored (control characters, bytes) are only made on a field this change wrote, so a member
 * can still move, tick, or tag a card whose notes the owner or the owner's agent wrote some
 * other way.
 */
function cardTooBig(p: Card | undefined, c: Card): string | null {
  const L = MEMBER_LIMITS;
  if (typeof c.title !== "string" || !c.title || c.title.length > L.title) return `[too_big] A card's title can be up to ${L.title} characters.`;
  if (typeof c.notes !== "string" || c.notes.length > L.notes) return `[too_big] A card's notes can be up to ${L.notes.toLocaleString("en-US")} characters.`;
  if (c.due !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(c.due))) return "[too_big] Due dates must look like 2026-09-30.";
  const tags = c.tags ?? [];
  if (!Array.isArray(tags) || tags.length > L.tags || tags.some((t) => typeof t !== "string" || !t || t.length > L.tag)) return `[too_big] A card can have ${L.tags} tags of up to ${L.tag} characters each.`;
  const wrote = { title: p?.title !== c.title, notes: p?.notes !== c.notes, tags: !same(p?.tags, c.tags) };
  if ((wrote.title && CONTROL.test(c.title)) || (wrote.notes && CONTROL_IN_NOTES.test(c.notes)) || (wrote.tags && tags.some((t) => CONTROL.test(t)))) return BAD_TEXT;
  if (wrote.title && jsonBytes(c.title) > L.titleBytes) return `[too_big] That title takes more room than a title gets (${L.titleBytes} bytes as stored). Shorten it.`;
  if (wrote.notes && jsonBytes(c.notes) > L.notesBytes) return `[too_big] Those notes take more room than a card's notes get (${L.notesBytes / 1024} KB as stored). Shorten them.`;
  const size = jsonBytes(c);
  if (size > L.cardBytes && (!p || size > jsonBytes(p))) return "[too_big] That card is too big to save.";
  return null;
}

/**
 * Why a writer's change is refused, or null when it's allowed. A writer changes cards and
 * nothing else, so this compares the board before and after instead of trusting which action
 * was called: lanes (names, order, sort, roles), the theme, encryption, and every other board
 * setting have to come out identical, a question on a card stays the owner's to answer or
 * take back, and so do the tags that direct the owner's agents and the cards that carry them
 * (OWNER_TAGS above). It runs on every change a member makes, whatever path it took.
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
    // A card this change added or touched has to be one a member may make: not an agent's
    // work order, no owner tag put on or taken off, and inside the limits. One it left alone
    // is the owner's business.
    if (!p || !same(p, c)) {
      const no = memberCardError(p, c);
      if (no) return no;
    }
    // A question is asked by an agent and answered by the owner. A member's change can't add,
    // edit, answer, or clear one, and can't rewrite the last answer either.
    if (!same(p?.ask, c.ask) || !same(p?.answer, c.answer)) return "Questions on a card are the board owner's to answer.";
    // Finishing a card with its question still open ends the agent's wait, the same as taking the question back.
    if (c.ask && done && c.laneId === done && p?.laneId !== done) return "That card has a question waiting on the board's owner.";
  }
  for (const p of before.cards) {
    if (now.has(p.id)) continue;
    if (isAgentCard(p)) return AGENT_CARD;
    if (p.ask) return "That card has a question waiting on the board's owner.";
  }
  // The order of the agents' cards is the order they're worked in ("take the top card"), so it
  // has to come out the same. Moving any other card never changes it.
  const queue = (b: Board) => b.cards.filter(isAgentCard).map((c) => c.id).join();
  if (queue(before) !== queue(after)) return AGENT_CARD;
  if (after.cards.length > before.cards.length && after.cards.length > MEMBER_LIMITS.cards) {
    return BOARD_FULL_CARDS;
  }
  const size = jsonBytes(after);
  if (size > MEMBER_LIMITS.boardBytes && size > jsonBytes(before)) return BOARD_FULL_BYTES;
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

/** People on one board, pending invites included, from the `MAX_BOARD_MEMBERS` var. The one place its default lives. */
export function memberCap(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 10;
}

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

/**
 * Sent to every open tab of a shared board, the owner's and members', when cards are deleted
 * or brought back by undo, so nobody's card vanishes without a word. `by` is stamped by the
 * board from the connection that did it. `undo` goes to the owner's tabs only: the undo step
 * that would put it back (TodoAgent.undoIf).
 */
export type ActivityFrame = {
  type: "tasks_activity";
  action: "card_deleted" | "card_restored";
  by: { email: string; via?: "assistant" | "agent" | "undo" | "redo" };
  /** The first few, for the toast. `count` is how many there were. */
  cards: { id: string; title: string; lane: string }[];
  count: number;
  undo?: number;
};

/** The frame a member's socket gets on connect and whenever its access changes. */
export type AccessFrame = { type: "tasks_access" } & Access & {
  /** Set on the last frame before the socket is closed. */
  closed?: "removed" | "encrypted";
};
/** WebSocket close code for a member who lost the board. */
export const CLOSE_NO_ACCESS = 4403;
/** Close code for a member's socket that kept sending after it was told to slow down. The app may reconnect. */
export const CLOSE_FLOOD = 4429;
/** Close code for a frame bigger than a member may send (MEMBER_FRAME_MAX in agent.ts). */
export const CLOSE_TOO_BIG = 1009;
