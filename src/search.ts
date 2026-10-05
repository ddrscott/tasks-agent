// Search over one user's cards, stored beside the board in the agent's SQLite.
//
// - Keyword: an FTS5 table of card titles and notes (porter stemming, prefix matches,
//   bm25 ranking with titles weighted 5x, highlighted snippets).
// - Semantic: an embedding per card from Workers AI, compared by cosine similarity.
//   A board is small (hundreds of cards), so a scan beats running a vector database.
//   Vectors are refreshed after changes and lazily before a search, so a search never
//   misses a card that changed a moment ago.
// - Hybrid (the default) merges both rankings with reciprocal rank fusion.
//
// Everything is per agent, so results can't cross between users.

import * as ops from "./shared";
import type { Board, Card } from "./shared";
import type { SearchHit, SearchInput, SearchResult } from "./tools";

const EMBED_BATCH = 50;
// Measured with bge-small on real cards: the right card scores 0.57–0.65, unrelated ones
// 0.30–0.54, and the gap between them is 0.08 or more. No single cutoff separates
// them across queries, so keep cards above a floor AND close to the best score.
const SEMANTIC_FLOOR = 0.52;
const SEMANTIC_MARGIN = 0.06;
// Words too common to search on.
const STOPWORDS = new Set(("a an and are as at be but by for from has have i in is it its me my of on or " +
  "so that the this to was we were what when where which who will with you your am do did not need").split(" "));
const RRF_K = 60;
const MARK = ["\u0001", "\u0002"] as const;

/** FNV-1a: cheap change detection for "does this card need a new embedding". */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

const textOf = (c: Card) => (c.notes ? `${c.title}\n${c.notes}` : c.title).slice(0, 2000);

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * Turn free text into a safe FTS5 query: quoted terms, common words dropped, and prefix
 * matching for terms of three or more letters (so "pass" finds "passport" but "i"
 * doesn't find "IRS").
 */
function ftsQuery(q: string, join: " " | " OR "): string | null {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms = words.filter((w) => !STOPWORDS.has(w)).slice(0, 12);
  const use = terms.length ? terms : words.slice(0, 12); // a query of only common words still searches
  return use.length ? use.map((t) => (t.length >= 3 ? `"${t}"*` : `"${t}"`)).join(join) : null;
}

export class CardIndex {
  private refreshing: Promise<void> | null = null;

  constructor(private sql: SqlStorage, private ai: Ai, private model: string) {}

  init() {
    this.sql.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS card_fts USING fts5(
      card_id UNINDEXED, title, notes, tokenize = 'porter unicode61 remove_diacritics 2')`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS card_vec (card_id TEXT PRIMARY KEY, hash TEXT NOT NULL, vec BLOB NOT NULL)`);
  }

  /** Index a board for the first time, e.g. one created before search existed. */
  backfill(board: Board) {
    const n = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM card_fts").one().n;
    if (n === 0 && board.cards.length) this.sync(null, board);
  }

  /** Drop every indexed title, note, and embedding, e.g. when the board is encrypted. */
  clear() {
    this.sql.exec("DELETE FROM card_fts");
    this.sql.exec("DELETE FROM card_vec");
  }

  /** Update the keyword index for what changed between two boards. Only touched cards are rewritten. */
  sync(before: Board | null, after: Board) {
    const old = new Map((before?.cards ?? []).map((c) => [c.id, c]));
    const now = new Set<string>();
    for (const c of after.cards) {
      now.add(c.id);
      const prev = old.get(c.id);
      if (prev && prev.title === c.title && prev.notes === c.notes) continue;
      this.sql.exec("DELETE FROM card_fts WHERE card_id = ?", c.id);
      this.sql.exec("INSERT INTO card_fts (card_id, title, notes) VALUES (?, ?, ?)", c.id, c.title, c.notes);
    }
    for (const id of old.keys()) {
      if (now.has(id)) continue;
      this.sql.exec("DELETE FROM card_fts WHERE card_id = ?", id);
      this.sql.exec("DELETE FROM card_vec WHERE card_id = ?", id);
    }
  }

  /** Embed cards that are new or changed since their last embedding. One run at a time. */
  refreshVectors(board: Board): Promise<void> {
    this.refreshing ??= this.embedStale(board).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async embedStale(board: Board) {
    const have = new Map(this.sql.exec<{ card_id: string; hash: string }>("SELECT card_id, hash FROM card_vec").toArray()
      .map((r) => [r.card_id, r.hash]));
    const stale = board.cards
      .map((c) => ({ c, h: hash(`${this.model}\n${textOf(c)}`) }))
      .filter(({ c, h }) => have.get(c.id) !== h);
    for (let i = 0; i < stale.length; i += EMBED_BATCH) {
      const batch = stale.slice(i, i + EMBED_BATCH);
      const vecs = await this.embed(batch.map(({ c }) => textOf(c)));
      batch.forEach(({ c, h }, j) => {
        this.sql.exec("INSERT OR REPLACE INTO card_vec (card_id, hash, vec) VALUES (?, ?, ?)", c.id, h, vecs[j].buffer);
      });
    }
  }

  private async embed(texts: string[]): Promise<Float32Array[]> {
    const out = (await this.ai.run(this.model as Parameters<Ai["run"]>[0], { text: texts } as never)) as { data?: number[][] };
    if (!out.data || out.data.length !== texts.length) throw new Error("embedding failed");
    return out.data.map((v) => Float32Array.from(v));
  }

  private keyword(q: string, limit: number, anyWord: boolean) {
    type Row = { card_id: string; t: string; s: string };
    const run = (m: string) => this.sql.exec<Row>(
      `SELECT card_id, highlight(card_fts, 1, char(1), char(2)) AS t,
              snippet(card_fts, 2, char(1), char(2), '…', 14) AS s
       FROM card_fts WHERE card_fts MATCH ? ORDER BY bm25(card_fts, 0.0, 5.0, 1.0) LIMIT ?`, m, limit).toArray();
    // Every word first. Keyword-only searches fall back to any word; hybrid leaves
    // loose matches to the semantic side, which ranks them by meaning.
    const all = ftsQuery(q, " ");
    if (!all) return [];
    const rows = run(all);
    return rows.length || !anyWord ? rows : run(ftsQuery(q, " OR ")!);
  }

  private async semantic(board: Board, q: string, limit: number): Promise<string[]> {
    await this.refreshVectors(board);
    const [qv] = await this.embed([q]);
    const ranked = this.sql.exec<{ card_id: string; vec: ArrayBuffer }>("SELECT card_id, vec FROM card_vec").toArray()
      .map((r) => ({ id: r.card_id, score: cosine(qv, new Float32Array(r.vec)) }))
      .sort((a, b) => b.score - a.score);
    const top = ranked[0]?.score ?? 0;
    return ranked
      .filter((r) => r.score >= SEMANTIC_FLOOR && r.score >= top - SEMANTIC_MARGIN)
      .slice(0, limit)
      .map((r) => r.id);
  }

  /** `owner` is the board owner's email: a hit on a card a member wrote on, tagged, or attached to says so (memberNote). */
  async search(board: Board, input: SearchInput, owner?: string | null): Promise<SearchResult> {
    const mode = input.mode ?? "hybrid";
    const limit = input.limit ?? 10;
    const lane = input.lane ? ops.findLane(board, input.lane) : undefined;
    if (input.lane && !lane) throw new Error(`No lane "${input.lane}". Lanes: ${board.lanes.map((l) => l.name).join(", ")}`);
    const tag = input.tag ? ops.cleanTag(input.tag) : "";
    const cards = new Map(board.cards.filter((c) => (!lane || c.laneId === lane.id) && (!tag || ops.hasTag(c, tag))).map((c) => [c.id, c]));
    const pool = lane || tag ? Math.max(limit * 4, 50) : limit * 2; // filter after ranking, so over-fetch

    const kw = mode === "semantic" ? [] : this.keyword(input.query, pool, mode === "keyword").filter((r) => cards.has(r.card_id));
    let sem: string[] = [];
    let semantic: SearchResult["semantic"] = mode === "keyword" ? "off" : "on";
    if (mode !== "keyword") {
      try {
        sem = (await this.semantic(board, input.query, pool)).filter((id) => cards.has(id));
      } catch (e) {
        console.warn("semantic search unavailable", (e as Error).message);
        semantic = "unavailable";
      }
    }

    const score = new Map<string, number>();
    kw.forEach((r, i) => score.set(r.card_id, (score.get(r.card_id) ?? 0) + 1 / (RRF_K + i)));
    sem.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + i)));
    const kwRow = new Map(kw.map((r) => [r.card_id, r]));
    const semSet = new Set(sem);
    const laneName = new Map(board.lanes.map((l) => [l.id, l.name]));

    const hits: SearchHit[] = [...score.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => {
        const c = cards.get(id)!;
        const k = kwRow.get(id);
        return {
          id,
          title: k?.t ?? c.title,
          snippet: k?.s.includes(MARK[0]) ? k.s : "",
          lane: laneName.get(c.laneId) ?? c.laneId,
          due: c.due,
          match: k && semSet.has(id) ? "both" : k ? "keyword" : "semantic",
          ...(ops.memberLine(c, owner) ? { member: ops.memberLine(c, owner) } : {}),
        };
      });
    return { hits, semantic };
  }
}
