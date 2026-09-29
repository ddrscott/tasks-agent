// Search for an end-to-end encrypted board. The server only has ciphertext, so it can't
// index anything; this runs over the decrypted board in the tab instead. Keyword only:
// every query word has to start a word in the title or notes (three letters or more match
// as a prefix, like the server's FTS5 index), titles count five times as much as notes,
// and matches are marked with \u0001…\u0002 the same way, so the search box doesn't care
// which one answered.

import type { Board } from "../shared";
import type { SearchHit, SearchResult } from "../tools";

const STOPWORDS = new Set(("a an and are as at be but by for from has have i in is it its me my of on or " +
  "so that the this to was we were what when where which who will with you your am do did not need").split(" "));

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function termsOf(q: string): string[] {
  const all = words(q);
  const kept = all.filter((w) => !STOPWORDS.has(w));
  return (kept.length ? kept : all).slice(0, 12);
}

const hits = (term: string, w: string) => (term.length >= 3 ? w.startsWith(term) : w === term);

/** Wrap each matching word in \u0001…\u0002. */
function mark(text: string, terms: string[]): string {
  return text.replace(/[\p{L}\p{N}]+/gu, (w) => (terms.some((t) => hits(t, w.toLowerCase())) ? `\u0001${w}\u0002` : w));
}

/** About 14 words of the notes around the first match. */
function snippet(notes: string, terms: string[]): string {
  const parts = notes.replace(/\s+/g, " ").trim().split(" ");
  const at = parts.findIndex((p) => words(p).some((w) => terms.some((t) => hits(t, w))));
  if (at < 0) return "";
  return mark(parts.slice(Math.max(0, at - 5), at + 9).join(" "), terms);
}

export function localSearch(board: Board, query: string, limit = 12): SearchResult {
  const terms = termsOf(query);
  if (!terms.length) return { hits: [], semantic: "off" };
  const lanes = new Map(board.lanes.map((l) => [l.id, l.name]));
  const scored: { hit: SearchHit; score: number }[] = [];
  for (const c of board.cards) {
    const tw = words(c.title);
    const nw = words(c.notes);
    let score = 0;
    let all = true;
    for (const t of terms) {
      const inTitle = tw.filter((w) => hits(t, w)).length;
      const inNotes = nw.filter((w) => hits(t, w)).length;
      if (!inTitle && !inNotes) { all = false; break; }
      score += inTitle * 5 + inNotes;
    }
    if (!all) continue;
    scored.push({
      score,
      hit: { id: c.id, title: mark(c.title, terms), snippet: snippet(c.notes, terms), lane: lanes.get(c.laneId) ?? "", due: c.due, match: "keyword" },
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return { hits: scored.slice(0, limit).map((s) => s.hit), semantic: "off" };
}
