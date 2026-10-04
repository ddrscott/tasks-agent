// Board model and pure operations, shared by the agent (server) and the UI (client).
// Every mutation goes through these functions, so drag-and-drop, buttons, and the
// chat agent's tools all change the board the same way.
//
// On an end-to-end encrypted board (`sealed` set, see sealed.ts) every piece of text arrives
// already encrypted by the browser. The ops pass sealed values through untouched, so the
// server still moves, deletes, and undoes by id without ever reading the text.

import { isSealed, kidOf, SEALED_TOKEN_RE, type SealInfo } from "./sealed";

export { isSealed, type SealInfo };

/** A file on a card. The bytes live in R2 under `<user id>/<attachment id>`; only this metadata is in the board. */
export type Attachment = {
  id: string;
  name: string;
  size: number; // bytes
  type: string; // MIME type as uploaded
  addedAt: string;
};

/** The tag that says a card is waiting on a decision from the board's owner. */
export const NEEDS_CEO_TAG = "needs-ceo";

/** A question an agent put on a card (ask_ceo), answered with one tap in the app. */
export type Ask = {
  question: string;
  options: string[]; // 2 to 4
  recommended?: number; // index into options
  askedAt: string;
};

/** The last answer given on a card. It stays until the next question, so an agent can read it back. */
export type Answer = { question: string; answer: string; choice?: number; at: string };

export const MAX_ASK_OPTIONS = 4;

export type Card = {
  id: string;
  title: string;
  notes: string;
  laneId: string;
  due: string | null; // YYYY-MM-DD
  createdAt: string;
  updatedAt: string;
  attachments?: Attachment[]; // missing on cards made before attachments existed
  tags?: string[]; // missing on cards made before tags existed, and on cards with none
  ask?: Ask; // an open question; never on an encrypted board
  answer?: Answer;
};

export const MAX_ATTACHMENTS_PER_CARD = 20;
export const MAX_TAGS_PER_CARD = 10;

/** `sort` is the order the lane keeps itself in (see `shownCards`). Without it, the lane is in manual order: the order of `Board.cards`. */
export type Lane = { id: string; name: string; sort?: SortBy };

export type Board = {
  lanes: Lane[];
  cards: Card[]; // array order is display order within each lane
  theme: string;
  /** True once the user picks a theme on this account; until then a new account keeps the browser's. */
  themeChosen?: boolean;
  /** Present when the board is end-to-end encrypted: the passphrase envelope for its key. */
  sealed?: SealInfo;
};

export const THEME_IDS = [
  "auto", "signal", "paper", "nord", "dracula", "solar", "forest",
  "sakura", "ocean", "synthwave", "newsprint", "contrast",
] as const;

export function newBoard(): Board {
  return {
    lanes: [
      { id: "todo", name: "To do" },
      { id: "doing", name: "Doing" },
      { id: "done", name: "Done" },
    ],
    cards: [],
    theme: "auto",
  };
}

// Short ids are easy for a small model to copy correctly.
export function shortId(prefix: string, taken: Set<string>): string {
  for (;;) {
    const id = prefix + Math.random().toString(36).slice(2, 6);
    if (!taken.has(id)) return id;
  }
}

export const laneCards = (b: Board, laneId: string) => b.cards.filter((c) => c.laneId === laneId);

export function findLane(b: Board, ref: string): Lane | undefined {
  const r = ref.trim().toLowerCase();
  return b.lanes.find((l) => l.id === ref) ?? b.lanes.find((l) => l.name.toLowerCase() === r);
}

function requireCard(b: Board, id: string): Card {
  const c = b.cards.find((c) => c.id === id);
  if (!c) throw new Error(`No card with id "${id}"`);
  return c;
}

function requireLane(b: Board, ref: string): Lane {
  const l = findLane(b, ref);
  if (!l) throw new Error(`No lane "${ref}". Lanes: ${b.lanes.map((l) => l.name).join(", ")}`);
  return l;
}

const now = () => new Date().toISOString();
export const clean = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);
/** Tidy plain text; sealed text is ciphertext and passes through as is. */
const tidy = (s: string, max: number) => (isSealed(s) ? s : clean(s, max));
const tidyNotes = (s: string) => (isSealed(s) ? s : s.slice(0, 4000));

/** One tag in its plain form: lower case, no leading #, spaces as dashes, letters, digits, - and _ only. */
export const cleanTag = (s: string) =>
  s.trim().replace(/^#+/, "").toLowerCase().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]/gu, "").slice(0, 32);

/** Every tag in use on the board, most used first, for suggesting in the Tags field. needs-ceo is set by ask_ceo, not by hand. */
export function tagsByUse(b: Board): string[] {
  const n = new Map<string, number>();
  for (const c of b.cards) for (const t of c.tags ?? []) if (!isSealed(t) && t !== NEEDS_CEO_TAG) n.set(t, (n.get(t) ?? 0) + 1);
  return [...n.keys()].sort((x, y) => n.get(y)! - n.get(x)! || x.localeCompare(y));
}

/** Tidy a tag list: clean each plain tag, drop blanks and repeats. Sealed tags pass through. */
export function tidyTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const v = isSealed(t) ? t : cleanTag(t);
    if (v && !out.includes(v)) out.push(v);
  }
  if (out.length > MAX_TAGS_PER_CARD) throw new Error(`A card can have ${MAX_TAGS_PER_CARD} tags`);
  return out;
}

/** Set a card's tags, leaving the field off when there are none. */
function withTags(c: Card, tags: string[]): Card {
  const { tags: _, ...rest } = c;
  return tags.length ? { ...rest, tags } : rest;
}

export const hasTag = (c: Card, tag: string) => (c.tags ?? []).includes(tag);

export function addCard(
  b: Board,
  input: { title: string; laneId?: string; notes?: string; due?: string | null; tags?: string[]; top?: boolean },
): { board: Board; card: Card } {
  const title = tidy(input.title, 200);
  if (!title) throw new Error("A card needs a title");
  const lane = input.laneId ? requireLane(b, input.laneId) : b.lanes[0];
  if (!lane) throw new Error("Add a lane first");
  const t = now();
  const card: Card = withTags({
    id: shortId("c", new Set(b.cards.map((c) => c.id))),
    title,
    notes: tidyNotes(input.notes ?? ""),
    laneId: lane.id,
    due: validDue(input.due),
    createdAt: t,
    updatedAt: t,
  }, tidyTags(input.tags ?? []));
  const cards = [...b.cards];
  if (input.top) {
    const first = cards.findIndex((c) => c.laneId === lane.id);
    cards.splice(first === -1 ? cards.length : first, 0, card);
  } else cards.push(card);
  return { board: { ...b, cards }, card };
}

export function updateCard(
  b: Board,
  id: string,
  patch: { title?: string; notes?: string; due?: string | null; tags?: string[] },
): Board {
  const card = requireCard(b, id);
  let next = { ...card, updatedAt: now() };
  if (patch.title !== undefined) {
    const title = tidy(patch.title, 200);
    if (!title) throw new Error("A card needs a title");
    next.title = title;
  }
  if (patch.notes !== undefined) next.notes = tidyNotes(patch.notes);
  if (patch.due !== undefined) next.due = validDue(patch.due);
  if (patch.tags !== undefined) next = withTags(next, tidyTags(patch.tags));
  // Taking #needs-ceo off by hand answers the question without picking an option, so it goes too.
  if (next.ask && !hasTag(next, NEEDS_CEO_TAG)) delete next.ask;
  return { ...b, cards: b.cards.map((c) => (c.id === id ? next : c)) };
}

/** Put a question on a card and mark it #needs-ceo. A new question replaces the old one and clears the last answer. */
export function askCard(b: Board, id: string, input: { question: string; options: string[]; recommended?: number }): Board {
  if (b.sealed) throw new Error("An encrypted board can't hold questions: they'd be stored unencrypted.");
  const card = requireCard(b, id);
  const question = clean(input.question, 240);
  if (!question) throw new Error("A question needs some text");
  const options = [...new Set(input.options.map((o) => clean(o, 140)).filter(Boolean))];
  if (options.length < 2 || options.length > MAX_ASK_OPTIONS) throw new Error(`Give 2 to ${MAX_ASK_OPTIONS} different options`);
  const rec = input.recommended;
  if (rec !== undefined && (!Number.isInteger(rec) || rec < 0 || rec >= options.length)) throw new Error("recommended has to be one of the options");
  const { answer: _, ...rest } = card;
  const tags = tidyTags([...(card.tags ?? []), NEEDS_CEO_TAG]);
  const next: Card = { ...withTags(rest, tags), updatedAt: now(), ask: { question, options, ...(rec !== undefined ? { recommended: rec } : {}), askedAt: now() } };
  return { ...b, cards: b.cards.map((c) => (c.id === id ? next : c)) };
}

/**
 * Answer a card's question, with one of its options or with typed text. The answer is kept on
 * the card and written as the first line of its notes, and #needs-ceo comes off, which is what
 * tells a listening agent (events.ts).
 */
export function answerAsk(b: Board, id: string, input: { choice?: number; text?: string }): Board {
  const card = requireCard(b, id);
  const ask = card.ask;
  if (!ask) throw new Error("That card has no open question");
  const typed = clean(input.text ?? "", 500);
  const choice = typed ? undefined : input.choice;
  if (!typed && (choice === undefined || !Number.isInteger(choice) || choice < 0 || choice >= ask.options.length)) throw new Error("Pick one of the options, or type an answer");
  const answer = typed || ask.options[choice!];
  const at = now();
  const { ask: _, ...rest } = card;
  const line = `ANSWER: ${answer} (asked: ${ask.question}) — ${at.slice(0, 16).replace("T", " ")} UTC`;
  const next: Card = {
    ...withTags(rest, (card.tags ?? []).filter((t) => t !== NEEDS_CEO_TAG)),
    notes: tidyNotes(card.notes ? `${line}\n\n${card.notes}` : line),
    answer: { question: ask.question, answer, ...(choice !== undefined ? { choice } : {}), at },
    updatedAt: at,
  };
  return { ...b, cards: b.cards.map((c) => (c.id === id ? next : c)) };
}

/** A card's open question or last answer in one line, for agents. */
export function describeAsk(c: Card): string {
  if (c.ask) return ` — ASKING: ${c.ask.question} [${c.ask.options.map((o, i) => `${i + 1}) ${o}${c.ask!.recommended === i ? " (recommended)" : ""}`).join(" | ")}]`;
  if (c.answer) return ` — ANSWERED: "${c.answer.answer}" to "${c.answer.question}"`;
  return "";
}

/** Move a card into a lane at `index` among that lane's cards (end when omitted). */
export function moveCard(b: Board, id: string, laneRef: string, index?: number): Board {
  const card = requireCard(b, id);
  const lane = requireLane(b, laneRef);
  const rest = b.cards.filter((c) => c.id !== id);
  const moved = { ...card, laneId: lane.id, updatedAt: card.laneId === lane.id ? card.updatedAt : now() };
  const inLane = rest.filter((c) => c.laneId === lane.id);
  const i = index === undefined ? inLane.length : Math.max(0, Math.min(index, inLane.length));
  let at: number;
  if (inLane.length === 0) at = rest.length;
  else if (i >= inLane.length) at = rest.indexOf(inLane[inLane.length - 1]) + 1;
  else at = rest.indexOf(inLane[i]);
  rest.splice(at, 0, moved);
  return { ...b, cards: rest };
}

/** The ways a lane can be sorted from its menu. `say` is how the toast names it. */
export const SORTS = [
  { by: "due", label: "Due date", say: "due date" },
  { by: "title", label: "Title A–Z", say: "title" },
  { by: "newest", label: "Newest first", say: "newest first" },
  { by: "oldest", label: "Oldest first", say: "oldest first" },
  { by: "updated", label: "Recently updated", say: "last updated" },
] as const;
export type SortBy = (typeof SORTS)[number]["by"];

/**
 * Card ids in sorted order. Ties keep the order they had. This runs in the browser, on the
 * decrypted cards, because the server can't read titles or due dates on an encrypted board.
 */
export function sortedIds(cards: Card[], by: SortBy): string[] {
  const cmp: Record<SortBy, (a: Card, b: Card) => number> = {
    // Cards with no due date go last.
    due: (a, b) => (a.due && b.due ? a.due.localeCompare(b.due) : Number(!a.due) - Number(!b.due)),
    title: (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }),
    newest: (a, b) => b.createdAt.localeCompare(a.createdAt),
    oldest: (a, b) => a.createdAt.localeCompare(b.createdAt),
    updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  };
  const f = cmp[by];
  if (!f) throw new Error(`Unknown sort ${String(by)}`);
  return cards.map((c, i) => ({ c, i })).sort((x, y) => f(x.c, y.c) || x.i - y.i).map((x) => x.c.id);
}

/**
 * A lane's cards in the order it shows them: by the lane's saved sort when it has one, else in
 * board order. The sort is a setting on the lane rather than a one-time shuffle, so a card that's
 * added, edited, or moved in later falls into place, and the choice follows the account to any
 * browser. On the server's copy of an encrypted board the titles and dates are ciphertext, so
 * there the cards stay in board order and the browser sorts its decrypted view.
 */
export function shownCards(b: Board, laneId: string): Card[] {
  const cards = laneCards(b, laneId);
  const by = b.lanes.find((l) => l.id === laneId)?.sort;
  if (!by || !SORTS.some((o) => o.by === by) || cards.some((c) => isSealed(c.title))) return cards;
  const order = sortedIds(cards, by);
  const byId = new Map(cards.map((c) => [c.id, c]));
  return order.map((id) => byId.get(id)!);
}

/** Keep a lane sorted by `by` from now on, or pass null to go back to manual order. */
export function setLaneSort(b: Board, laneRef: string, by: SortBy | null): Board {
  const lane = requireLane(b, laneRef);
  if (by !== null && !SORTS.some((o) => o.by === by)) throw new Error(`Unknown sort ${String(by)}`);
  return { ...b, lanes: b.lanes.map((l) => {
    if (l.id !== lane.id) return l;
    const { sort: _was, ...rest } = l;
    return by ? { ...rest, sort: by } : rest;
  }) };
}

/** Put a lane's cards in the order of `ids`, which must be exactly that lane's cards. Other lanes don't move. */
export function orderLane(b: Board, laneRef: string, ids: string[]): Board {
  const lane = requireLane(b, laneRef);
  const inLane = b.cards.filter((c) => c.laneId === lane.id);
  const byId = new Map(inLane.map((c) => [c.id, c]));
  if (!Array.isArray(ids) || ids.length !== inLane.length || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id))) {
    throw new Error(`${lane.name} changed while it was being sorted. Try again.`);
  }
  let n = 0;
  return { ...b, cards: b.cards.map((c) => (c.laneId === lane.id ? byId.get(ids[n++])! : c)) };
}

export function addAttachment(b: Board, cardId: string, att: Attachment): Board {
  const card = requireCard(b, cardId);
  const list = card.attachments ?? [];
  if (list.length >= MAX_ATTACHMENTS_PER_CARD) throw new Error(`A card can hold ${MAX_ATTACHMENTS_PER_CARD} attachments`);
  const next = { ...card, attachments: [...list, att], updatedAt: now() };
  return { ...b, cards: b.cards.map((c) => (c.id === cardId ? next : c)) };
}

/** Take a file off a card. The R2 object stays until nothing, including undo history, points at it. */
export function removeAttachment(b: Board, cardId: string, attId: string): Board {
  const card = requireCard(b, cardId);
  const list = card.attachments ?? [];
  if (!list.some((a) => a.id === attId)) throw new Error(`No attachment "${attId}" on that card`);
  const next = { ...card, attachments: list.filter((a) => a.id !== attId), updatedAt: now() };
  return { ...b, cards: b.cards.map((c) => (c.id === cardId ? next : c)) };
}

/** Every attachment id a board refers to. */
export function attachmentIds(b: Board): string[] {
  return b.cards.flatMap((c) => (c.attachments ?? []).map((a) => a.id));
}

export function deleteCards(b: Board, ids: string[]): Board {
  ids.forEach((id) => requireCard(b, id));
  return { ...b, cards: b.cards.filter((c) => !ids.includes(c.id)) };
}

export function addLane(b: Board, name: string): { board: Board; lane: Lane } {
  const n = tidy(name, 40);
  if (!n) throw new Error("A lane needs a name");
  if (!isSealed(n) && findLane(b, n)) throw new Error(`There is already a lane called "${n}"`);
  if (b.lanes.length >= 8) throw new Error("Boards are limited to 8 lanes");
  const lane = { id: shortId("l", new Set(b.lanes.map((l) => l.id))), name: n };
  return { board: { ...b, lanes: [...b.lanes, lane] }, lane };
}

export function renameLane(b: Board, ref: string, name: string): Board {
  const lane = requireLane(b, ref);
  const n = tidy(name, 40);
  if (!n) throw new Error("A lane needs a name");
  const clash = isSealed(n) ? undefined : findLane(b, n);
  if (clash && clash.id !== lane.id) throw new Error(`There is already a lane called "${n}"`);
  return { ...b, lanes: b.lanes.map((l) => (l.id === lane.id ? { ...l, name: n } : l)) };
}

/** Delete a lane and every card in it. */
export function deleteLane(b: Board, ref: string): Board {
  const lane = requireLane(b, ref);
  if (b.lanes.length === 1) throw new Error("A board needs at least one lane");
  return {
    ...b,
    lanes: b.lanes.filter((l) => l.id !== lane.id),
    cards: b.cards.filter((c) => c.laneId !== lane.id),
  };
}

export function moveLane(b: Board, ref: string, index: number): Board {
  const lane = requireLane(b, ref);
  const lanes = b.lanes.filter((l) => l.id !== lane.id);
  lanes.splice(Math.max(0, Math.min(index, lanes.length)), 0, lane);
  return { ...b, lanes };
}

function validDue(due: string | null | undefined): string | null {
  if (!due) return null;
  if (isSealed(due)) return due;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(due))) {
    throw new Error(`Due dates must look like 2026-09-30, got "${due}"`);
  }
  return due;
}

/** How much of a card's notes the board listing shows. get_card (mcp.ts) returns the rest. */
const NOTES_PREVIEW = 120;

/** The start of a card's notes on one line, saying how much was left out so nobody mistakes the preview for the whole note. */
function previewNotes(notes: string): string {
  const flat = notes.replace(/\s+/g, " ").trim();
  return flat.length <= NOTES_PREVIEW ? flat : `${flat.slice(0, NOTES_PREVIEW)}… [+${flat.length - NOTES_PREVIEW} more characters]`;
}

/** One line per lane with its card count: what a write tool echoes over MCP in place of the whole board. */
export function describeLaneCounts(b: Board): string {
  return b.lanes.map((l) => `${l.name} ${laneCards(b, l.id).length}`).join(" · ");
}

/** Everything on one card, as plain text: the full notes, and each attachment with its id, type, and size. */
export function describeCard(b: Board, id: string): string | null {
  const c = b.cards.find((x) => x.id === id);
  if (!c) return null;
  const lane = b.lanes.find((l) => l.id === c.laneId);
  const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
  const lines = [
    `[${c.id}] ${c.title}`,
    `Lane: ${lane?.name ?? "?"} (lane id ${c.laneId})`,
    `Tags: ${c.tags?.length ? c.tags.map((t) => `#${t}`).join(" ") : "(none)"}`,
    `Due: ${c.due ?? "(none)"}`,
    `Created: ${c.createdAt}${c.updatedAt && c.updatedAt !== c.createdAt ? ` · updated: ${c.updatedAt}` : ""}`,
  ];
  if (c.ask) lines.push(`Asking the owner: ${c.ask.question}`, ...c.ask.options.map((o, i) => `  ${i + 1}) ${o}${c.ask!.recommended === i ? " (recommended)" : ""}`));
  if (c.answer) lines.push(`Owner answered: "${c.answer.answer}" to "${c.answer.question}"`);
  lines.push(c.attachments?.length
    ? `Attachments (${c.attachments.length}):\n${c.attachments.map((a) => `  - [${a.id}] ${a.name} (${a.type}, ${kb(a.size)})`).join("\n")}`
    : "Attachments: (none)");
  lines.push(c.notes ? `Notes (${c.notes.length} characters):\n${c.notes}` : "Notes: (none)");
  return lines.join("\n");
}

/** Plain-text board for the model's context. With `tag`, only the cards carrying it. */
export function describeBoard(b: Board, tag?: string): string {
  return b.lanes
    .map((l) => {
      const cards = shownCards(b, l.id).filter((c) => !tag || hasTag(c, tag));
      const sorted = l.sort ? `, sorted by ${SORTS.find((o) => o.by === l.sort)?.say ?? l.sort}` : "";
      const lines = cards.map(
        (c) =>
          `  - [${c.id}] ${c.title}${c.tags?.length ? ` ${c.tags.map((t) => `#${t}`).join(" ")}` : ""}` +
          `${c.due ? ` (due ${c.due})` : ""}${describeAsk(c)}${c.notes ? ` — notes: ${previewNotes(c.notes)}` : ""}` +
          (c.attachments?.length ? ` — attached: ${c.attachments.map((a) => a.name).join(", ")}` : ""),
      );
      return `${l.name} (lane id ${l.id}, ${cards.length} ${tag ? `#${tag} ` : ""}cards${sorted})\n${lines.join("\n") || "  (empty)"}`;
    })
    .join("\n");
}

/**
 * On an encrypted board, refuse anything that isn't ciphertext: lane names, titles, notes,
 * due dates, tags, attachment names and types. This is what stops plaintext from reaching an
 * encrypted board by any path (an outside agent, the cloud model, or a client bug).
 */
export function assertSealedBoard(b: Board): void {
  if (!b.sealed) return;
  const kid = b.sealed.kid;
  const ok = (v: string) => isSealed(v) && kidOf(v) === kid;
  const bad = (what: string) => { throw new Error(`This board is end-to-end encrypted, and the ${what} wasn't encrypted with its key. Only the app, unlocked with your passphrase, can change it.`); };
  for (const l of b.lanes) if (!ok(l.name)) bad("lane name");
  for (const c of b.cards) {
    if (!ok(c.title)) bad("card title");
    if (c.notes && !ok(c.notes)) bad("card notes");
    if (c.due !== null && !ok(c.due)) bad("due date");
    for (const t of c.tags ?? []) if (!ok(t)) bad("tag");
    if (c.ask || c.answer) bad("question");
    for (const a of c.attachments ?? []) if (!ok(a.name) || !ok(a.type)) bad("attachment name");
  }
}

/** Same lanes and cards, by id and position. Used when a whole board is swapped for its encrypted or decrypted twin. */
export function sameShape(a: Board, b: Board): boolean {
  const shape = (x: Board) => JSON.stringify({ l: x.lanes.map((l) => l.id), c: x.cards.map((c) => [c.id, c.laneId, (c.attachments ?? []).length]) });
  return shape(a) === shape(b);
}

/** Whether a string holds any ciphertext, for example a tool summary that quotes a sealed title. */
export const hasSealedText = (s: string) => new RegExp(SEALED_TOKEN_RE.source).test(s);

/** Every piece of text on a board, for checking that a decrypted board really is plain. */
export function boardTexts(b: Board): string[] {
  return [
    ...b.lanes.map((l) => l.name),
    ...b.cards.flatMap((c) => [c.title, c.notes, c.due ?? "", ...(c.tags ?? []), ...(c.attachments ?? []).flatMap((a) => [a.name, a.type])]),
  ].filter(Boolean);
}
