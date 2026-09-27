// The board as a tool schema for Needle, and Needle's answer as board tool calls.
//
// Needle 3 is a 121M tool-calling model. It can't be handed card ids and a page of board
// text the way GLM is, but it's very good at one thing: picking an option from an enum.
// So every card title becomes an enum value and every lane name another, and the model's
// per-option probabilities (`decisions` in its envelope) say which card the person meant
// and how sure it is. The client (src/client/needle.ts) and the bench (bench/needle.mjs)
// both go through here, so what ships is what was measured. No DOM, no Workers types.

import type { Board } from "./shared";
import type { ToolName } from "./tools";

/** One OpenAI-style function schema, the shape Needle reads. */
export type NeedleTool = {
  type: "function";
  function: { name: string; description: string; parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] } };
};

export type NeedleToolset = {
  tools: NeedleTool[];
  /** The system text: today's date and what the lanes mean. */
  system: string;
  /** A key that changes whenever the schema would: the engine re-reads tools only then. */
  key: string;
  /** Enum title → card id. */
  cardIds: Map<string, string>;
  /** Enum lane name → lane id. */
  laneIds: Map<string, string>;
};

/** The envelope needle-rs returns from `complete()` and `decide()`. */
export type NeedleEnvelope = {
  function_calls?: { name: string; arguments: Record<string, unknown> }[];
  suppressed_calls?: { name: string; arguments: Record<string, unknown> }[];
  confidence?: number;
  decisions?: { tool: string; argument: string; choice: string; probabilities: Record<string, number> }[];
  reasoning?: string;
  validation?: { ungrounded?: unknown };
};

const MAX_TITLE = 60;

/** The confidence a local turn needs, on the engine's call and on the card match. Set from bench/run.mjs --score. */
export const NEEDLE_THRESHOLD = 0.8;

/** Enum values must be distinct; a second "Call the dentist" gets a suffix, and the map keeps both. */
function enumTitles(board: Board): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const c of board.cards) {
    const base = c.title.trim().slice(0, MAX_TITLE) || "(untitled)";
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.set(n === 1 ? base : `${base} (${n})`, c.id);
  }
  return out;
}

/** Build the tools for this board. `today` is "YYYY-MM-DD" in the person's zone; `weekday` its name. */
export function buildNeedleTools(board: Board, today: string, weekday: string): NeedleToolset {
  const cardIds = enumTitles(board);
  const laneIds = new Map(board.lanes.map((l) => [l.name, l.id]));
  const lanes = Array.from(laneIds.keys());
  // The model is a verb router: it reads "booked", "started", "delete" far better than it reads
  // lane semantics, so the tools are the verbs and the client turns each into a lane move.
  const task = { type: "string", description: "The words the person used for the task, copied from their message" };
  const due = { type: "string", description: "A date as YYYY-MM-DD, or a weekday name, today, tomorrow, next week" };
  const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]): NeedleTool =>
    ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });
  const tools: NeedleTool[] = [
    fn("finished", "The person finished, completed, did, paid, sent, booked, or fixed a task that is on their board.", { task }, ["task"]),
    fn("started", "The person started, is working on, or picked up a task that is on their board.", { task }, ["task"]),
    fn("reopen", "A task that was finished turns out not to be done; put it back.", { task }, ["task"]),
    fn("move", "Put a task in a lane the person names.", { task, lane: { type: "string", enum: lanes } }, ["task", "lane"]),
    fn("set_due", "Give a task a due date, or push it to a date.", { task, due }, ["task", "due"]),
    fn("add", "Add a new task that is not on the board yet.", { title: { type: "string", description: "Short task title" }, due }, ["title"]),
    fn("delete", "Delete or remove a task for good. Only when they say delete or remove.", { task }, ["task"]),
  ];
  const usable = board.cards.length ? tools : tools.filter((t) => t.function.name === "add");
  const system = `today: ${today} (${weekday}). lanes: ${lanes.join(", ")}.`;
  const key = JSON.stringify([today, lanes, board.cards.length > 0]);
  return { tools: usable, system, key, cardIds, laneIds };
}

const STOP = new Set([
  "the", "a", "an", "my", "our", "to", "for", "of", "on", "in", "at", "and", "card", "task", "thing", "ticket", "item", "up", "it", "is", "that", "this", "with", "about",
  // status words: "taxes are filed" is about the taxes, not the filing
  "are", "was", "were", "got", "went", "done", "finish", "complet", "paid", "pay", "sent", "send", "book", "fix", "merg", "ship", "file", "call", "cancel", "order", "submit", "start", "work", "pick", "reopen", "back", "now", "today",
]);

// The verb tool the model picked has to show up in the person's own words, or the turn goes to the big model.
const FINISHED = /\b(finished|finish|done|did|paid|sent|booked|fixed|merged|shipped|completed|closed|returned|dropped off|filed|called|cancell?ed|ordered|submitted|resolved|deployed|released|delivered|handled|wrapped up|taken care of|sorted)\b/i;
const STARTED = /\b(started|starting|start on|working on|work on|picking up|picked up|began|begin|underway|in progress|kicking off)\b/i;
const REOPEN = /\b(reopen|isn't done|is not done|not done|wasn't done|back to|put back|reverted|didn't go through|again|undo that|not finished)\b/i;
const DATEISH = /\b(today|tomorrow|tonight|next week|this week|(mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?|sun)(day)?|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\b\d{1,2}(st|nd|rd|th)?\b|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}/i;

/** Crude stem: "booked" → "book", "flights" → "flight", "filed" → "file", "cleaning" → "clean". */
export function stem(w: string): string {
  let x = w.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (x.length <= 3) return x;
  for (const suf of ["ing", "ies", "ed", "es", "s", "ly"]) {
    if (x.endsWith(suf) && x.length - suf.length >= 3) { x = x.slice(0, -suf.length); if (suf === "ies") x += "y"; break; }
  }
  return x;
}

const words = (s: string) => s.split(/[^A-Za-z0-9']+/).map(stem).filter((w) => w && !STOP.has(w));

export type CardMatch = { id: string; score: number; margin: number; title: string };

/**
 * Which card "the amazon return" or "flights" means. Every word the person used has to be
 * found in the card's title or notes (stemmed), and the best card has to beat the runner-up
 * by a clear margin; otherwise the caller sends the turn to the big model.
 */
export function matchCard(board: Board, phrase: string): CardMatch | null {
  const q = Array.from(new Set(words(phrase)));
  if (!q.length) return null;
  const scored = board.cards.map((c) => {
    const title = new Set(words(c.title));
    const notes = new Set(words(c.notes ?? ""));
    // "renewal" hits "renew", "flight" hits "flights": a shared stem of four letters or more counts.
    const has = (set: Set<string>, w: string) => set.has(w) || Array.from(set).some((t) => t.length >= 4 && w.length >= 4 && (t.startsWith(w) || w.startsWith(t)));
    let hit = 0;
    for (const w of q) { if (has(title, w)) hit += 1; else if (has(notes, w)) hit += 0.6; }
    // Words in the title that the person didn't say cost a little, so "Pay dentist bill" loses to "Book dentist cleaning" on "dentist cleaning".
    const extra = Array.from(title).filter((w) => !q.includes(w)).length;
    return { id: c.id, title: c.title, score: hit / q.length - 0.05 * extra };
  }).sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < 0.5) return null;
  const margin = best.score - (scored[1]?.score ?? 0);
  return { id: best.id, title: best.title, score: Math.min(1, Math.max(0, best.score)), margin };
}

/** "friday", "tomorrow", "next week", "2026-10-03" → "YYYY-MM-DD", or null when it isn't a date we understand. */
export function resolveDate(text: string | undefined | null, today: string): string | null | undefined {
  if (text == null || text === "") return undefined;
  const t = String(text).trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const base = new Date(`${today}T12:00:00Z`);
  const shift = (days: number) => new Date(base.getTime() + days * 86_400_000).toISOString().slice(0, 10);
  if (t === "today") return shift(0);
  if (t === "tomorrow") return shift(1);
  if (t === "next week") return shift(7);
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const m = t.match(/^(?:next |this |on |by )?(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/);
  if (m) {
    const want = days.findIndex((d) => d.startsWith(m[1]));
    const cur = base.getUTCDay();
    let ahead = (want - cur + 7) % 7;
    if (ahead === 0 || t.startsWith("next ")) ahead += 7; // "friday" on a Friday means next Friday
    return shift(ahead);
  }
  return null;
}

export type LocalCall = { name: ToolName; input: unknown };

export type Resolution =
  | { ok: true; calls: LocalCall[]; confidence: number; minChoice: number; summary: string }
  | { ok: false; reason: string; confidence: number };

/**
 * Turn an envelope into board tool calls, or say why the turn should go to the big model.
 * `threshold` applies to the engine's confidence and to the card match; `text` is the message,
 * so a lane the person named has to show up as a move.
 */
export function resolveEnvelope(env: NeedleEnvelope, board: Board, text: string, today: string, threshold: number): Resolution {
  const confidence = Number(env.confidence) || 0;
  const raw = env.function_calls ?? [];
  if (!raw.length) return { ok: false, reason: env.suppressed_calls?.length ? "the engine withheld its call" : "no call", confidence };
  if (confidence < threshold) return { ok: false, reason: `confidence ${confidence.toFixed(2)} under ${threshold}`, confidence };
  // The engine flags a normalized date ("Oct 15" → 2026-10-15) as ungrounded; that one is fine. A task or title that isn't in the message is not.
  const ungrounded = Array.isArray(env.validation?.ungrounded) ? (env.validation!.ungrounded as string[]).filter((u) => !/\.due$/.test(String(u))) : [];
  if (ungrounded.length) return { ok: false, reason: `"${ungrounded[0]}" wasn't in the message`, confidence };
  if (/\bnotes?\b/i.test(text)) return { ok: false, reason: "notes are for the big model", confidence };

  // The same call twice ("dentist cleaning" and "dentist cleaning.") is one call.
  const seen = new Set<string>();
  const calls = raw.filter((c) => { const k = `${c.name}:${JSON.stringify(c.arguments ?? {}).toLowerCase().replace(/[.!?]/g, "")}`; if (seen.has(k)) return false; seen.add(k); return true; });

  const lanes = board.lanes;
  const lower = text.toLowerCase();
  const named = lanes.find((l) => l.name.length >= 3 && lower.includes(l.name.toLowerCase()));
  if (named && !calls.every((c) => c.name === "move")) return { ok: false, reason: `"${named.name}" is a lane name; that's a move for the big model`, confidence };
  // "finished taxes and registration" is two cards; one call for it would leave one behind.
  const ands = (lower.match(/\band\b/g) ?? []).length;
  if (ands && calls.length < ands + 1) return { ok: false, reason: "more things named than calls made", confidence };
  // Which lane "finished", "started", and "reopen" mean is read off the lane names. A board whose
  // names don't say (four lanes, none called Doing) sends those turns to the big model.
  const byName = (re: RegExp) => lanes.find((l) => re.test(l.name))?.id;
  const last = byName(/\b(done|finished|shipped|complete|completed|closed|released|live)\b/i) ?? (lanes.length <= 3 ? lanes[lanes.length - 1]?.id : undefined);
  const middle = byName(/\b(doing|in progress|wip|working|active|started|now|today)\b/i) ?? (lanes.length === 3 ? lanes[1]?.id : undefined);
  const first = byName(/\b(to ?do|backlog|inbox|open|later|ideas|someday|queue)\b/i) ?? (lanes.length <= 3 ? lanes[0]?.id : undefined);

  let minChoice = 1;
  const out: LocalCall[] = [];
  const parts: string[] = [];
  const which = (phrase: unknown): CardMatch | { reason: string } => {
    if (typeof phrase !== "string" || !phrase.trim()) return { reason: "no task named" };
    const m = matchCard(board, phrase);
    if (!m) return { reason: `no card matches "${phrase}"` };
    if (m.score < threshold || m.margin < 0.25) return { reason: `"${phrase}" could be more than one card` };
    minChoice = Math.min(minChoice, m.score);
    return m;
  };
  for (const c of calls) {
    const a = c.arguments ?? {};
    switch (c.name) {
      case "finished": case "started": case "reopen": {
        const said = c.name === "finished" ? FINISHED.test(text) && !STARTED.test(text) && !REOPEN.test(text)
          : c.name === "started" ? STARTED.test(text) && !REOPEN.test(text)
          : REOPEN.test(text);
        if (!said) return { ok: false, reason: `the message doesn't say "${c.name}"`, confidence };
        const m = which(a.task); if ("reason" in m) return { ok: false, reason: m.reason, confidence };
        const lane = c.name === "finished" ? last : c.name === "started" ? middle : first;
        if (!lane) return { ok: false, reason: `the lane names don't say where "${c.name}" goes`, confidence };
        out.push({ name: "move_cards", input: { ids: [m.id], lane } });
        parts.push(`${c.name} "${m.title}"`);
        break;
      }
      case "move": {
        const m = which(a.task); if ("reason" in m) return { ok: false, reason: m.reason, confidence };
        const lane = lanes.find((l) => l.name === a.lane)?.id;
        if (!lane) return { ok: false, reason: "the lane didn't match the board", confidence };
        out.push({ name: "move_cards", input: { ids: [m.id], lane } });
        parts.push(`moved "${m.title}" to ${a.lane}`);
        break;
      }
      case "set_due": {
        if (!DATEISH.test(text)) return { ok: false, reason: "no date in the message", confidence };
        const m = which(a.task); if ("reason" in m) return { ok: false, reason: m.reason, confidence };
        const due = resolveDate(a.due as string, today);
        if (!due) return { ok: false, reason: `couldn't read the date "${a.due}"`, confidence };
        out.push({ name: "update_card", input: { id: m.id, due } });
        parts.push(`"${m.title}" due ${due}`);
        break;
      }
      case "add": {
        const title = typeof a.title === "string" ? a.title.trim() : "";
        if (!title) return { ok: false, reason: "no title for the new card", confidence };
        // "Called mom" isn't a new task when a card already says so; that's a finish for the big model to judge.
        if (matchCard(board, title)?.margin! >= 0.5 && (matchCard(board, title)?.score ?? 0) >= 0.9) return { ok: false, reason: `"${title}" looks like a card that's already there`, confidence };
        const due = resolveDate(a.due as string | undefined, today);
        if (due === null) return { ok: false, reason: `couldn't read the date "${a.due}"`, confidence };
        out.push({ name: "add_cards", input: { cards: [{ title, ...(due ? { due } : {}) }] } });
        parts.push(`added "${title}"${due ? ` due ${due}` : ""}`);
        break;
      }
      case "delete": {
        if (!/\b(delete|remove|get rid of|trash)\b/i.test(text)) return { ok: false, reason: "delete without the word delete", confidence };
        const m = which(a.task); if ("reason" in m) return { ok: false, reason: m.reason, confidence };
        out.push({ name: "delete_cards", input: { ids: [m.id] } });
        parts.push(`deleted "${m.title}"`);
        break;
      }
      default:
        return { ok: false, reason: `unknown tool ${c.name}`, confidence };
    }
  }
  return { ok: true, calls: out, confidence, minChoice, summary: parts.join("; ") };
}

/**
 * Messages the small model shouldn't even try: questions, and anything with two or more
 * clauses, which it tends to answer with one call. Cheap and conservative on purpose.
 */
export function looksSimple(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 140) return false;
  if (/\?\s*$/.test(t) || /^(what|which|when|who|how|why|is|are|do|does|can|show|list|tell)\b/i.test(t)) return false;
  const clauses = t.split(/[;\n]|,\s*(?:and|then)\s|\s(?:and then|and also)\s/i).filter((s) => s.trim());
  return clauses.length === 1;
}
