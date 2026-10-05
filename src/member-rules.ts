// The rules for team boards, with nothing in them but logic: who gets what role, what a member
// may call, and what a member's change may touch. src/members.ts feeds them from D1, and
// src/agent.ts enforces them inside the board's Durable Object. `npm run check:members` runs
// them on their own.

import { doneLaneId } from "./lanes";
import { AGENT_TAG, forAgent, GAUNTLET_TAG, NEEDS_CEO_TAG, SHIP_OK_TAG, type Board, type Card } from "./shared";

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

/**
 * HTTP calls about someone else's board (`?board=<id>`: the access check, attachment uploads
 * and downloads, the socket upgrade). Each one costs D1 reads and usually a call into the
 * owner's board object, and none of them went through the socket's bucket, so a viewer's
 * script could make hundreds a second. They draw on a bucket of their own, per signed-in
 * account: `burst` at once, which is a page with a few dozen image attachments opening, and
 * `perSecond` after that. Past it the answer is 429 with Retry-After.
 */
export const MEMBER_HTTP_RATE = { burst: 60, perSecond: 5, strikes: Number.MAX_SAFE_INTEGER } as const;
export const SLOW_DOWN_HTTP = "Slow down. That's too many requests at once. Wait a few seconds and try again.";
/** Whole seconds until a bucket that just refused has a token again. */
export const retryAfter = (b: Bucket, rate: { perSecond: number } = MEMBER_HTTP_RATE) => Math.max(1, Math.ceil((1 - b.tokens) / rate.perSecond));

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

// ---------- text nobody can see ----------
//
// A member's text is read by the owner on screen and by the owner's agents as characters, and
// those have to be the same thing. So what can't be seen comes out of everything a member
// writes (title, notes, tags, a file's name) before it's stored:
//
// - direction overrides, embeddings, isolates, and marks (U+202A to U+202E, U+2066 to U+2069,
//   U+200E, U+200F, U+061C), which make a line read differently on screen than in memory;
// - the Unicode tag block (U+E0000 to U+E007F), a full invisible copy of ASCII that a model
//   reads as words;
// - zero-width spaces, the word joiner, the byte-order mark, the soft hyphen, blank filler
//   letters, invisible math operators, and the deprecated format characters;
// - half of a surrogate pair with no other half.
//
// Two kinds of zero-width character do something a person sees, and are kept where they do:
// a joiner (U+200D) between two emoji, which is how a family or a flag is one picture, a
// joiner or non-joiner (U+200C) between two letters of a script that shapes with them
// (Arabic, Syriac, N'Ko, Mongolian, and the Indic scripts), and a variation selector right
// after a visible character (the heart that's red, not black). Anywhere else they go too.

const ALWAYS_HIDDEN = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\ufeff\uffa0\ufff9-\ufffb\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}]/gu;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const PICTURE = String.raw`[\p{Extended_Pictographic}\p{Emoji_Modifier}\ufe0f\u20e3]`;
const SHAPED = String.raw`[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Nko}\p{Script=Mongolian}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]`;
/** A joiner that isn't joining anything a person would see joined. */
const STRAY_JOINER = new RegExp(String.raw`(?<!${PICTURE}|${SHAPED})[\u200c\u200d]+|[\u200c\u200d]+(?!${PICTURE}|${SHAPED})|(?<=${PICTURE})\u200c+`, "gu");
/** A variation selector with no visible character in front of it to vary. */
const STRAY_SELECTOR = /(?<![^\s\ufe00-\ufe0f\u{e0100}-\u{e01ef}])[\ufe00-\ufe0f\u{e0100}-\u{e01ef}]+|(?<=[\ufe00-\ufe0f\u{e0100}-\u{e01ef}])[\ufe00-\ufe0f\u{e0100}-\u{e01ef}]+/gu;
const ANY_ZERO_WIDTH = /[\u200c\u200d\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;

/**
 * `s` without the characters nobody can see (above). `strict` takes every joiner and variation
 * selector too: that's for tags and file names, which are names, not prose.
 */
export function visibleText(s: string, strict = false): string {
  let out = s.replace(LONE_SURROGATE, "").replace(ALWAYS_HIDDEN, "");
  if (strict) return out.replace(ANY_ZERO_WIDTH, "");
  // Taking one out can leave another with nothing beside it, so go round until it settles.
  for (let i = 0; i < 4; i++) {
    const next = out.replace(STRAY_JOINER, "").replace(STRAY_SELECTOR, "");
    if (next === out) break;
    out = next;
  }
  return out;
}
/** Whether a title has anything to read in it: something that isn't a space, a joiner, or a selector. */
const hasInk = (s: string) => visibleText(s, true).trim().length > 0;
const BLANK_TITLE = "[bad_text] A card needs a title someone can read. That one was only spaces or invisible characters.";
const HIDDEN_TEXT = "[bad_text] Card text can't hold invisible characters (zero-width spaces, direction overrides, hidden tag characters). Take them out and try again.";

/**
 * A member's card with what can't be seen taken out of the fields this change wrote: the
 * title, the notes, the tags. `p` is the card before, or undefined for a new one. A field the
 * change left alone is left alone here too, so the owner's own text is never rewritten by a
 * member moving or tagging the card. A title that comes out empty stays empty, and the write
 * guard refuses it in words (BLANK_TITLE).
 */
export function memberTidyCard(p: Card | undefined, c: Card): Card {
  if (typeof c.title !== "string" || typeof c.notes !== "string") return c;
  let next = c;
  if (p?.title !== c.title) {
    const title = visibleText(c.title).replace(/\s+/g, " ").trim();
    if (title !== c.title) next = { ...next, title };
  }
  if (p?.notes !== c.notes) {
    const notes = visibleText(c.notes);
    if (notes !== c.notes) next = { ...next, notes };
  }
  if (Array.isArray(c.tags) && !same(p?.tags, c.tags) && c.tags.every((t) => typeof t === "string")) {
    const tags = [...new Set(c.tags.map((t) => (p?.tags?.includes(t) ? t : visibleText(t, true))).filter(Boolean))];
    if (!same(tags, c.tags)) {
      const { tags: _, ...rest } = next;
      next = tags.length ? { ...rest, tags } : rest;
    }
  }
  return next;
}

/** Every card a member's change added or rewrote, tidied (memberTidyCard). The board runs this on a member's change before the write guard sees it. */
export function memberTidy(before: Board, after: Board): Board {
  if (before.cards === after.cards || after.sealed) return after;
  const was = new Map(before.cards.map((c) => [c.id, c]));
  let touched = false;
  const cards = after.cards.map((c) => {
    const p = was.get(c.id);
    if (p === c) return c;
    const next = memberTidyCard(p, c);
    if (next !== c) touched = true;
    return next;
  });
  return touched ? { ...after, cards } : after;
}

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

// A tag doesn't have to be an owner tag to be read as one. `\u0430gent` with a Cyrillic \u0430,
// `\uff41\uff47\uff45\uff4e\uff54` in fullwidth letters, `ship_ok`, `shipok`, `agent-`, `ag3nt`, and `agen\u0167`
// all look like the owner's on a card's face, and an agent that matches tags loosely would
// take them. So what a member adds is compared by how it reads, not by its code points
// (`ownerTagLike`). Only the comparison is folded: the owner's own tags are stored as typed,
// and so is a member's tag that reads like nothing of the owner's.
//
// The reading is built from rules first and a table second, because no table of look-alike
// letters is ever complete:
//
//  1. Compatibility forms are unfolded (NFKD: fullwidth, ligatures, superscripts, math
//     alphabets), accents and invisible characters come out, everything is lower-cased, and
//     whatever isn't a letter or a digit is dropped. `ship-ok`, `ship_ok`, `shipok` are one.
//  2. A digit reads as itself or as the letter it's used for (0 o, 1 l or i, 3 e, 4 a, 5 s,
//     6 g, 7 t, 8 b, 9 g).
//  3. A letter of another alphabet that's drawn like a Latin one reads as that one
//     (`LOOKS_LIKE`: Cyrillic, Greek, Armenian, Cherokee, Lisu, and some odd Latin).
//  4. Any other Latin-script letter outside a to z (\u0167, \u0260, \u01ad, an IPA letter) reads as
//     whatever letter is needed: every one of them is some Latin letter with something done
//     to it. So does an unknown letter of any script when it's mixed in with plain a to z.
//  5. A tag that reads exactly as an owner tag under 1 to 4 is refused. A tag that has any
//     letter outside a to z is also refused when it's one letter away from one (one letter
//     swapped, added, or missing), which covers a look-alike nothing above knows.
//
// Plain a-to-z words are only ever judged by rules 1 and 2, so `agents`, `urgent`, `reagent`,
// `agency`, `shipping`, `ship`, `ok`, and `agent2` are a member's to use. So is a word in
// another alphabet that isn't a letter away from an owner tag: Russian `\u0430\u0433\u0435\u043d\u0442` reads `areht`.

/** Characters that take no room on screen: zero-width spaces and joiners, the soft hyphen, direction marks, variation selectors, and blank filler letters. */
const INVISIBLE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0]|\udb40[\udc00-\uddef]/g;
/** Letters of other alphabets, and Latin letters outside a to z, that are drawn like a plain Latin one. Not every such letter there is: the common ones. Rules 4 and 5 above are for the rest. */
const LOOKS_LIKE: Readonly<Record<string, string>> = (() => {
  const t: Record<string, string> = {
    // Cyrillic
    "\u0430": "a", "\u0432": "b", "\u0441": "c", "\u0501": "d", "\u0435": "e", "\u050d": "g", "\u04bb": "h", "\u043d": "h", "\u0456": "i", "\u0458": "j", "\u043a": "k", "\u04cf": "l", "\u043c": "m",
    "\u043f": "n", "\u043e": "o", "\u0440": "p", "\u051b": "q", "\u0433": "r", "\u0455": "s", "\u0442": "t", "\u0438": "u", "\u051d": "w", "\u0445": "x", "\u0443": "y",
    // Greek
    "\u03b1": "a", "\u03b2": "b", "\u03b5": "e", "\u03b7": "n", "\u03b9": "i", "\u03ba": "k", "\u03bd": "v", "\u03bf": "o", "\u03c1": "p", "\u03c2": "s", "\u03c3": "o", "\u03c4": "t", "\u03c5": "u", "\u03c7": "x", "\u03b3": "y",
    // Armenian
    "\u0581": "g", "\u0570": "h", "\u0578": "n", "\u057d": "u", "\u0585": "o",
    // Latin letters outside a to z: script and small-capital forms, and letters with a stroke
    "\u0251": "a", "\u1d00": "a", "\u1d04": "c", "\u0111": "d", "\u1d07": "e", "\u0261": "g", "\u0262": "g", "\u01e5": "g", "\u0127": "h", "\u029c": "h", "\u0131": "i", "\u0269": "i", "\u026a": "i",
    "\u1d0b": "k", "\u0142": "l", "\u029f": "l", "\u0274": "n", "\u00f8": "o", "\u1d0f": "o", "\u1d18": "p", "\ua731": "s", "\u1d1b": "t", "\u1d1c": "u",
  };
  // Cherokee and Lisu each hold a set of letters drawn like Latin capitals. Cherokee has two
  // cases, and lower-casing turns one into the other, so both are filled in from one list.
  const cherokee: Record<string, string> = {
    "\u13aa": "a", "\u13f4": "b", "\u13df": "c", "\u13a0": "d", "\u13ac": "e", "\u13c0": "g", "\u13bb": "h", "\u13a5": "i", "\u13ab": "j", "\u13e6": "k", "\u13de": "l", "\u13b7": "m",
    "\u13c1": "n", "\u13be": "o", "\u13e2": "p", "\u13a1": "r", "\u13da": "s", "\u13d5": "s", "\u13a2": "t", "\u13d9": "v", "\u13cc": "u", "\u13b3": "w", "\u13d4": "w", "\u13c3": "z", "\u13a9": "y",
  };
  for (const [ch, as] of Object.entries(cherokee)) { t[ch] = as; t[ch.toLowerCase()] = as; }
  const lisu = "bp.dt.gk.jc.zf.mnlsr..vh..wxy.a.e.iou...";
  [...lisu].forEach((as, i) => { if (as !== ".") t[String.fromCodePoint(0xa4d0 + i)] = as; });
  return t;
})();
/** What a digit can stand in for. */
const DIGIT_AS: Readonly<Record<string, string>> = { "0": "o", "1": "li", "3": "e", "4": "a", "5": "s", "6": "g", "7": "t", "8": "b", "9": "g" };
const ANY = "*";
/**
 * How a tag reads, one entry per character: the letters it can be taken for (`*` for any).
 * `odd` says it has a letter outside a to z, which is what turns on the one-letter-away rule.
 */
function readingOf(s: string): { cells: string[]; odd: boolean } {
  const chars = [...s.normalize("NFKD").replace(/\p{M}/gu, "").replace(INVISIBLE, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")];
  const plain = chars.some((ch) => ch >= "a" && ch <= "z");
  let odd = false;
  const cells = chars.map((ch) => {
    if (ch >= "a" && ch <= "z") return ch;
    if (ch >= "0" && ch <= "9") return ch + (DIGIT_AS[ch] ?? "");
    if (/\p{L}/u.test(ch)) odd = true;
    const like = LOOKS_LIKE[ch];
    if (like) return like;
    return /\p{Script=Latin}/u.test(ch) || (plain && /\p{L}/u.test(ch)) ? ANY : ch;
  });
  return { cells, odd };
}
const fits = (cell: string, ch: string) => cell === ANY || cell.includes(ch);
/** Whether `cells` reads as `word`, letter for letter. */
const readsAs = (cells: string[], word: string) => cells.length === word.length && cells.every((cell, i) => fits(cell, word[i]));
/** Whether `cells` is `word` with at most one letter swapped, added, or missing. */
function oneAway(cells: string[], word: string): boolean {
  if (Math.abs(cells.length - word.length) > 1) return false;
  let prev = Array.from({ length: word.length + 1 }, (_, j) => j);
  for (let i = 1; i <= cells.length; i++) {
    const row = [i];
    for (let j = 1; j <= word.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (fits(cells[i - 1], word[j - 1]) ? 0 : 1));
    prev = row;
  }
  return prev[word.length] <= 1;
}
const OWNER_READINGS: readonly (readonly [string, string])[] = OWNER_TAGS.map((t) => [t.replace(/[^a-z0-9]/g, ""), t] as const);
/** The owner tag that `tag` is, or reads as: `agent` for `agent`, for `\u0430gent`, for `ag3nt`, and for `agent-`. Null for a tag that's nobody's but the member's. */
export function ownerTagLike(tag: unknown): string | null {
  if (typeof tag !== "string" || tag.length > 200) return null;
  const { cells, odd } = readingOf(tag);
  if (!cells.length) return null;
  for (const [word, owner] of OWNER_READINGS) if (readsAs(cells, word)) return owner;
  if (odd) for (const [word, owner] of OWNER_READINGS) if (oneAway(cells, word)) return owner;
  return null;
}
/** A card that's a work order for the owner's agents (`agent` or `gauntlet`): read only to members. */
export const isAgentCard = (c: Pick<Card, "tags">) => forAgent(c as Card);
/** Which owner tag a member is trying to add or remove between two versions of a card, if any. */
function ownerTagChanged(p: Card | undefined, c: Card): string | null {
  return OWNER_TAGS.find((t) => !!p?.tags?.includes(t) !== !!c.tags?.includes(t)) ?? null;
}
/**
 * A tag a member is adding that reads as an owner tag without being one, as [what they typed,
 * the owner tag it reads as]. Only tags this change adds: a look-alike the owner put there
 * themselves stays the owner's business, and doesn't lock a member out of the card.
 */
function lookalikeAdded(p: Card | undefined, c: Card): [string, string] | null {
  if (!Array.isArray(c.tags)) return null;
  for (const t of c.tags) {
    if (typeof t !== "string" || isOwnerTag(t) || p?.tags?.includes(t)) continue;
    const like = ownerTagLike(t);
    if (like) return [t, like];
  }
  return null;
}
/**
 * An owner tag written into a title with its `#` ("Do evil #agent", "Do #agent evil",
 * "[#agent]"). It isn't a tag there, but on a card's face it looks like one that took, and a
 * model reading the title sees the same thing. So a member's title can't hold one anywhere.
 * `#agents` and "talk to the agent" are just words.
 */
export function ownerTagInTitle(title: string): string | null {
  // Read the way it shows: `\uff03agent` is #agent, and an invisible character inside the tag isn't there.
  const shown = title.normalize("NFKC").replace(INVISIBLE, "");
  for (const m of shown.matchAll(/[#\u266f\u2317]([\p{L}\p{N}\p{M}_-]{1,64})/gu)) {
    const tag = ownerTagLike(m[1]);
    if (tag) return tag;
  }
  return null;
}
/** `typed` is what the member wrote when it only reads as the owner's tag: the refusal says which tag it was taken for. */
export const ownerTagError = (tag: string, typed?: string) =>
  `[owner_tag] ${typed && typed !== tag ? `#${typed.slice(0, 40)} reads as #${tag}. ` : ""}Only the board's owner can put #${tag} on a card or take it off. The owner's agents take their orders from that tag.`;
export const AGENT_CARD = "[agent_card] That card is a work order for the owner's agents (it's tagged #agent or #gauntlet). Only the board's owner can change, move, or delete it.";

/** Why a member can't make this card what it now is, looking at the card alone. `p` is the card before, or undefined for a new one. */
function memberCardError(p: Card | undefined, c: Card): string | null {
  if (p && isAgentCard(p)) return AGENT_CARD;
  const tag = ownerTagChanged(p, c) ?? (typeof c.title === "string" && p?.title !== c.title ? ownerTagInTitle(c.title) : null);
  if (tag) return ownerTagError(tag);
  const like = lookalikeAdded(p, c);
  if (like) return ownerTagError(like[1], like[0]);
  return cardTooBig(p, c);
}

/**
 * Why a member can't move these cards, or null. Comparing the board before and after can't
 * tell "the work order moved up one" from "the card above it moved down one": they're the same
 * board. So a move is also judged by which card the call names: a work order is never the one
 * a member moves, to another lane or inside its own. The write guard still holds the rest
 * (its lane, and its place among the other work orders) whatever was called.
 */
export function memberMoveError(b: Board, ids: unknown): string | null {
  const moving = new Set(Array.isArray(ids) ? ids : [ids]);
  return b.cards.some((c) => moving.has(c.id) && isAgentCard(c)) ? AGENT_CARD : null;
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
/** Room kept for the marks the board stamps on a card after this is asked: who added it, and that its words and tags are a member's (stampBy). */
const BY_ROOM = 1024;

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
  if (typeof c.title === "string" && p?.title !== c.title && !hasInk(c.title)) return BLANK_TITLE;
  if (typeof c.title !== "string" || !c.title || c.title.length > L.title) return `[too_big] A card's title can be up to ${L.title} characters.`;
  if (typeof c.notes !== "string" || c.notes.length > L.notes) return `[too_big] A card's notes can be up to ${L.notes.toLocaleString("en-US")} characters.`;
  if (c.due !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(c.due))) return "[too_big] Due dates must look like 2026-09-30.";
  const tags = c.tags ?? [];
  if (!Array.isArray(tags) || tags.length > L.tags || tags.some((t) => typeof t !== "string" || !t || t.length > L.tag)) return `[too_big] A card can have ${L.tags} tags of up to ${L.tag} characters each.`;
  const wrote = { title: p?.title !== c.title, notes: p?.notes !== c.notes, tags: !same(p?.tags, c.tags) };
  if ((wrote.title && CONTROL.test(c.title)) || (wrote.notes && CONTROL_IN_NOTES.test(c.notes)) || (wrote.tags && tags.some((t) => CONTROL.test(t)))) return BAD_TEXT;
  // The board takes these out of a member's text before it gets here (memberTidy). This is for a path that didn't.
  if ((wrote.title && visibleText(c.title) !== c.title) || (wrote.notes && visibleText(c.notes) !== c.notes) || (wrote.tags && tags.some((t) => !p?.tags?.includes(t) && visibleText(t, true) !== t))) return HIDDEN_TEXT;
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
/**
 * Dev servers only (DEV_LOGIN_CODES=1): hold a member's connect this many milliseconds between
 * its access check and accepting the socket, so `check:members` can land a removal in the gap.
 * Local D1 answers too fast to race otherwise. Ignored everywhere else.
 */
export const H_HOLD = "x-tasks-dev-hold";
export const INTERNAL_HEADERS = [
  H_USER, H_EMAIL, H_MEMBER, H_HOLD, "x-user",
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

/**
 * How old a member socket's access check may be for the board to be pushed to it without
 * asking D1 again. This is the read window when a "membership changed" signal is lost for
 * good: a removed member's open tab can be sent the board for this long after its last check,
 * and no longer. The next push checks first, and closes it.
 */
export const MEMBER_PUSH_FRESH_MS = 5000;

/** The waits before each try at telling the board its membership changed: at once, then backing off. */
export const SIGNAL_WAITS_MS: readonly number[] = [0, 200, 800, 2400];

/**
 * Run `fn` until it works, waiting `waits[i]` before try i. Returns how many tries it took, or
 * throws the last error once they're used up. `pause` is there so a test doesn't have to wait.
 */
export async function withRetries<T>(fn: () => Promise<T>, waits: readonly number[], onFail?: (e: unknown, attempt: number) => void, pause: (ms: number) => Promise<unknown> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<{ value: T; tries: number }> {
  let last: unknown;
  for (let i = 0; i < waits.length; i++) {
    if (waits[i] > 0) await pause(waits[i]);
    try { return { value: await fn(), tries: i + 1 }; } catch (e) { last = e; onFail?.(e, i + 1); }
  }
  throw last;
}

/**
 * Whether the board may be pushed to a member's socket on the strength of the access check it
 * remembers. The check has to have begun under the current membership epoch (so nothing read
 * before the last "membership changed" counts, including a read that was in flight when it
 * landed) and within `maxAgeMs`. Otherwise the socket is checked against D1 first.
 */
export function pushFresh(m: { at: number; ep: number; effective: Effective }, epoch: number, now: number, maxAgeMs: number): boolean {
  return m.ep === epoch && now - m.at < maxAgeMs && m.effective !== "none";
}

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
