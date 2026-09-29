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

export type Card = {
  id: string;
  title: string;
  notes: string;
  laneId: string;
  due: string | null; // YYYY-MM-DD
  createdAt: string;
  updatedAt: string;
  attachments?: Attachment[]; // missing on cards made before attachments existed
};

export const MAX_ATTACHMENTS_PER_CARD = 20;

export type Lane = { id: string; name: string };

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

export function addCard(
  b: Board,
  input: { title: string; laneId?: string; notes?: string; due?: string | null; top?: boolean },
): { board: Board; card: Card } {
  const title = tidy(input.title, 200);
  if (!title) throw new Error("A card needs a title");
  const lane = input.laneId ? requireLane(b, input.laneId) : b.lanes[0];
  if (!lane) throw new Error("Add a lane first");
  const t = now();
  const card: Card = {
    id: shortId("c", new Set(b.cards.map((c) => c.id))),
    title,
    notes: tidyNotes(input.notes ?? ""),
    laneId: lane.id,
    due: validDue(input.due),
    createdAt: t,
    updatedAt: t,
  };
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
  patch: { title?: string; notes?: string; due?: string | null },
): Board {
  const card = requireCard(b, id);
  const next = { ...card, updatedAt: now() };
  if (patch.title !== undefined) {
    const title = tidy(patch.title, 200);
    if (!title) throw new Error("A card needs a title");
    next.title = title;
  }
  if (patch.notes !== undefined) next.notes = tidyNotes(patch.notes);
  if (patch.due !== undefined) next.due = validDue(patch.due);
  return { ...b, cards: b.cards.map((c) => (c.id === id ? next : c)) };
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

/** Plain-text board for the model's context. */
export function describeBoard(b: Board): string {
  return b.lanes
    .map((l) => {
      const cards = laneCards(b, l.id);
      const lines = cards.map(
        (c) =>
          `  - [${c.id}] ${c.title}${c.due ? ` (due ${c.due})` : ""}${c.notes ? ` — notes: ${clean(c.notes, 120)}` : ""}` +
          (c.attachments?.length ? ` — attached: ${c.attachments.map((a) => a.name).join(", ")}` : ""),
      );
      return `${l.name} (lane id ${l.id}, ${cards.length} cards)\n${lines.join("\n") || "  (empty)"}`;
    })
    .join("\n");
}

/**
 * On an encrypted board, refuse anything that isn't ciphertext: lane names, titles, notes,
 * due dates, attachment names and types. This is what stops plaintext from reaching an
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
    ...b.cards.flatMap((c) => [c.title, c.notes, c.due ?? "", ...(c.attachments ?? []).flatMap((a) => [a.name, a.type])]),
  ].filter(Boolean);
}
