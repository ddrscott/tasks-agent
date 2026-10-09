// Search across every board a person can reach: their own boards and the ones shared with
// them, cards and pages alike (// SEARCH in the README).
//
// - Keyword: one FTS5 table in D1 (migrations/0010_search.sql) with a row per card and per
//   page, keyed by board id. Each board's Durable Object writes its own rows as things change
//   (TodoAgent.reindex, Docs.writePage), so a search is one query over the ids the caller
//   may see, ranked by bm25 with titles weighted 5x, with highlighted snippets.
// - Semantic: Vectorize, when the Worker has the VECTORS binding (wrangler.jsonc). Each card
//   and page is one vector from the same Workers AI model the per-board search uses, with the
//   board's id in its metadata, so a query filters to the caller's boards. Without the
//   binding, or when it fails, the result says `semantic: "unavailable"` and the keyword
//   hits stand alone, the same as the per-board search does when Workers AI is down.
// - Hybrid (the default) merges both rankings with reciprocal rank fusion.
//
// Encrypted boards have no rows anywhere here: the server can't read them.

import { currentUser, type User } from "./auth";
import { ownedBoards, type BoardRef } from "./boards";
import { sharedBoards } from "./members";
import { BOARD_ID } from "./member-rules";
import { ftsQuery, MARK, RRF_K, SEMANTIC_FLOOR, SEMANTIC_MARGIN } from "./search";
import type { SearchHit, SearchResult } from "./tools";

export type Kind = "card" | "page";
/** One thing in the index: a card (ref = its id) or a page (ref = its path). */
export type Entry = { kind: Kind; ref: string; title: string; body: string; meta?: CardMeta };
/** What a card hit shows without going back to its board. */
export type CardMeta = { lane: string; due: string | null; assignee?: string };

/** The most of a page's text that's keyword-indexed, and the part of it that's embedded. */
const BODY_MAX = 64 * 1024;
const EMBED_MAX = 2000;
/** What the embedding model (EMBEDDING_MODEL, bge-small) produces, and so what the index was created with. */
export const VECTOR_DIMS = 384;
/** D1 binds at most 100 values to one statement; the IN list of boards stays well under. */
const BOARDS_MAX = 60;
const LIMIT_DEFAULT = 10;
const LIMIT_MAX = 50;

/** A board the caller can search: theirs, or shared with them. */
export type Reachable = { id: string; name: string; ownerEmail: string; shared: boolean };

/** Vectorize ids are at most 64 bytes, and a page's path can be 200: the id is a hash of the ref, and the ref itself is metadata. */
async function vectorId(board: string, kind: Kind, ref: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${kind}\n${ref}`)));
  return `${board}:${[...h.subarray(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const vectors = (env: Env): VectorizeIndex | null => (env.VECTORS as VectorizeIndex | undefined) ?? null;

/** Write (or rewrite) these entries' rows for a board. Vectors are the caller's to send (upsertVectors). */
export async function indexEntries(env: Env, board: string, entries: Entry[]): Promise<void> {
  if (!entries.length) return;
  const stmts: D1PreparedStatement[] = [];
  for (const e of entries) {
    stmts.push(env.DB.prepare("DELETE FROM search_fts WHERE board = ? AND kind = ? AND ref = ?").bind(board, e.kind, e.ref));
    stmts.push(env.DB.prepare("INSERT INTO search_fts (board, kind, ref, meta, title, body) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(board, e.kind, e.ref, e.meta ? JSON.stringify(e.meta) : null, e.title.slice(0, 500), e.body.slice(0, BODY_MAX)));
  }
  await env.DB.batch(stmts);
}

/** Take entries out of both indexes. */
export async function dropEntries(env: Env, board: string, kind: Kind, refs: string[]): Promise<void> {
  if (!refs.length) return;
  await env.DB.batch(refs.map((ref) => env.DB.prepare("DELETE FROM search_fts WHERE board = ? AND kind = ? AND ref = ?").bind(board, kind, ref)));
  const v = vectors(env);
  if (v) await v.deleteByIds(await Promise.all(refs.map((ref) => vectorId(board, kind, ref)))).catch((e: Error) => console.warn("vector delete failed", e.message));
}

/** A board's object has checked its rows are in (or has nothing to put in): searches needn't wake it. */
export async function markIndexed(env: Env, board: string, kind: Kind): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO search_boards (board, kind, at) VALUES (?, ?, ?)").bind(board, kind, Date.now()).run();
}
/** The object is starting again: the next search over it asks it to check its rows (ensureSearch), once. */
export async function unmarkIndexed(env: Env, board: string, kind: Kind): Promise<void> {
  await env.DB.prepare("DELETE FROM search_boards WHERE board = ? AND kind = ?").bind(board, kind).run();
}
/** How many rows of a kind a board has. */
export async function countIndexed(env: Env, board: string, kind: Kind): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM search_fts WHERE board = ? AND kind = ?").bind(board, kind).first<{ n: number }>())?.n ?? 0;
}
/** Replace every row of a kind for a board with `entries`, in one batch. */
export async function resetEntries(env: Env, board: string, kind: Kind, entries: Entry[]): Promise<void> {
  const stmts = [env.DB.prepare("DELETE FROM search_fts WHERE board = ? AND kind = ?").bind(board, kind)];
  for (const e of entries) {
    stmts.push(env.DB.prepare("INSERT INTO search_fts (board, kind, ref, meta, title, body) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(board, e.kind, e.ref, e.meta ? JSON.stringify(e.meta) : null, e.title.slice(0, 500), e.body.slice(0, BODY_MAX)));
  }
  await env.DB.batch(stmts);
}

/**
 * Wake the objects of any of `boards` that haven't indexed themselves yet (a board from before
 * the index existed, or whose first write failed), and wait for them, so this search sees
 * them. Each board's objects do this once (ensureSearch on TodoAgent and Docs); after that
 * it's one cheap read here.
 */
export async function ensureIndexed(env: Env, boards: Reachable[]): Promise<void> {
  if (!boards.length) return;
  const marks = boards.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(`SELECT board, kind FROM search_boards WHERE board IN (${marks})`).bind(...boards.map((b) => b.id)).all<{ board: string; kind: Kind }>();
  const have = new Set(results.map((r) => `${r.board}\n${r.kind}`));
  const wake: Promise<unknown>[] = [];
  for (const b of boards) {
    if (!have.has(`${b.id}\ncard`)) wake.push(env.TodoAgent.get(env.TodoAgent.idFromName(b.id)).ensureSearch().catch((e: Error) => console.warn("waking a board for search failed", e.message)));
    if (!have.has(`${b.id}\npage`)) wake.push(env.Docs.get(env.Docs.idFromName(b.id)).ensureSearch().catch((e: Error) => console.warn("waking a board's pages for search failed", e.message)));
  }
  await Promise.all(wake);
}

/** Everything of a board's: when it's encrypted, reset, or its cards are all rewritten. Vectors of one kind stay unless `kinds` names it. */
export async function dropBoard(env: Env, board: string, kinds: Kind[] = ["card", "page"]): Promise<void> {
  await env.DB.batch(kinds.map((k) => env.DB.prepare("DELETE FROM search_fts WHERE board = ? AND kind = ?").bind(board, k)));
  // Vectorize has no delete-by-filter: a board's vectors are found by a query that names it, in rounds.
  const v = vectors(env);
  if (!v) return;
  try {
    for (const kind of kinds) {
      for (let round = 0; round < 20; round++) {
        const r = await v.query(new Array(VECTOR_DIMS).fill(0), { topK: 100, filter: { board, kind }, returnMetadata: "none" });
        if (!r.matches.length) break;
        await v.deleteByIds(r.matches.map((m) => m.id));
        if (r.matches.length < 100) break;
      }
    }
  } catch (e) {
    console.warn("dropping a board's vectors failed", (e as Error).message);
  }
}

/** Put embeddings in the vector index. A no-op without the binding. */
export async function upsertVectors(env: Env, board: string, items: { kind: Kind; ref: string; vec: Float32Array }[]): Promise<void> {
  const v = vectors(env);
  if (!v || !items.length) return;
  const rows: VectorizeVector[] = [];
  for (const it of items) rows.push({ id: await vectorId(board, it.kind, it.ref), values: Array.from(it.vec), metadata: { board, kind: it.kind, ref: it.ref } });
  await v.upsert(rows);
}

/** Embed texts with the app's model. Throws when Workers AI is unavailable. */
export async function embed(env: Env, texts: string[]): Promise<Float32Array[]> {
  const out = (await env.AI.run(env.EMBEDDING_MODEL as Parameters<Ai["run"]>[0], { text: texts.map((t) => t.slice(0, EMBED_MAX)) } as never)) as { data?: number[][] };
  if (!out.data || out.data.length !== texts.length) throw new Error("embedding failed");
  return out.data.map((v) => Float32Array.from(v));
}

/** The boards `user` may search, their own first. `only` narrows to one, by id or name (case aside); null when it names none. */
export async function reachable(env: Env, user: User, only?: string): Promise<Reachable[] | null> {
  const own: Reachable[] = (await ownedBoards(env, user)).map((b: BoardRef) => ({ id: b.id, name: b.name, ownerEmail: b.ownerEmail, shared: false }));
  const theirs: Reachable[] = (await sharedBoards(env, user))
    .filter((s) => s.effective === "viewer" || s.effective === "writer")
    .map((s) => ({ id: s.board, name: s.name, ownerEmail: s.ownerEmail, shared: true }));
  const all = [...own, ...theirs].slice(0, BOARDS_MAX);
  if (only === undefined) return all;
  const want = only.trim().toLowerCase();
  const one = all.find((b) => b.id === only) ?? all.find((b) => b.name.toLowerCase() === want || (b.shared && b.ownerEmail.toLowerCase() === want));
  return one ? [one] : null;
}

export type AllInput = { query: string; mode?: "hybrid" | "keyword" | "semantic"; limit?: number; kind?: Kind };
type Row = { board: string; kind: Kind; ref: string; meta: string | null; t: string; s: string };

/**
 * Search `boards` for `input.query`. Hits carry the board's id and name and whether the hit
 * is a card or a page; a card hit has the card's lane and due date from the index. Whether a
 * member wrote on a card isn't known here: the caller asks the board (memberLine) if it wants it.
 */
export async function searchAll(env: Env, boards: Reachable[], input: AllInput): Promise<SearchResult> {
  const mode = input.mode ?? "hybrid";
  const limit = Math.min(Math.max(input.limit ?? LIMIT_DEFAULT, 1), LIMIT_MAX);
  const pool = limit * 2;
  if (!boards.length) return { hits: [], semantic: mode === "keyword" ? "off" : "on" };
  const byId = new Map(boards.map((b) => [b.id, b]));
  const key = (r: { board: string; kind: string; ref: string }) => `${r.board}\n${r.kind}\n${r.ref}`;

  const kw = mode === "semantic" ? [] : await keyword(env, boards.map((b) => b.id), input.query, pool, mode === "keyword", input.kind);
  let sem: { board: string; kind: Kind; ref: string }[] = [];
  let semantic: SearchResult["semantic"] = mode === "keyword" ? "off" : "on";
  if (mode !== "keyword") {
    try {
      sem = await meaning(env, boards.map((b) => b.id), input.query, pool, input.kind);
    } catch (e) {
      console.warn("semantic search unavailable", (e as Error).message);
      semantic = "unavailable";
    }
  }

  const score = new Map<string, number>();
  kw.forEach((r, i) => score.set(key(r), (score.get(key(r)) ?? 0) + 1 / (RRF_K + i)));
  sem.forEach((r, i) => score.set(key(r), (score.get(key(r)) ?? 0) + 1 / (RRF_K + i)));
  const kwRow = new Map(kw.map((r) => [key(r), r]));
  const semSet = new Set(sem.map(key));
  const top = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k]) => k);

  // A hit the keyword side didn't see has no title in hand: read it, and the card's meta, from the index.
  const missing = top.filter((k) => !kwRow.has(k));
  const plain = new Map<string, Row>();
  if (missing.length) {
    const rows = await env.DB.batch<Row>(missing.map((k) => {
      const [board, kind, ref] = k.split("\n");
      return env.DB.prepare("SELECT board, kind, ref, meta, title AS t, '' AS s FROM search_fts WHERE board = ? AND kind = ? AND ref = ?").bind(board, kind, ref);
    }));
    rows.forEach((r) => { const row = r.results[0]; if (row) plain.set(key(row), row); });
  }

  const hits: SearchHit[] = [];
  for (const k of top) {
    const row = kwRow.get(k) ?? plain.get(k);
    if (!row) continue; // a vector whose row is gone: the board deleted it a moment ago
    const b = byId.get(row.board);
    if (!b) continue;
    const meta = (row.meta ? JSON.parse(row.meta) : {}) as Partial<CardMeta>;
    const k2 = kwRow.get(k);
    hits.push({
      id: row.ref,
      title: row.t,
      snippet: k2?.s.includes(MARK[0]) ? k2.s : "",
      lane: row.kind === "page" ? "page" : meta.lane ?? "",
      due: meta.due ?? null,
      match: k2 && semSet.has(k) ? "both" : k2 ? "keyword" : "semantic",
      board: b.id,
      boardName: b.name,
      kind: row.kind,
      ...(meta.assignee ? { assignee: meta.assignee } : {}),
    });
  }
  return { hits, semantic };
}

async function keyword(env: Env, boards: string[], q: string, limit: number, anyWord: boolean, kind?: Kind): Promise<Row[]> {
  const run = async (m: string) => {
    const marks = boards.map(() => "?").join(", ");
    const r = await env.DB.prepare(
      `SELECT board, kind, ref, meta, highlight(search_fts, 4, char(1), char(2)) AS t, snippet(search_fts, 5, char(1), char(2), '…', 14) AS s
       FROM search_fts WHERE search_fts MATCH ? AND board IN (${marks})${kind ? " AND kind = ?" : ""}
       ORDER BY bm25(search_fts, 0.0, 0.0, 0.0, 0.0, 5.0, 1.0) LIMIT ?`,
    ).bind(m, ...boards, ...(kind ? [kind] : []), limit).all<Row>();
    return r.results;
  };
  const all = ftsQuery(q, " ");
  if (!all) return [];
  const rows = await run(all);
  return rows.length || !anyWord ? rows : run(ftsQuery(q, " OR ")!);
}

async function meaning(env: Env, boards: string[], q: string, limit: number, kind?: Kind): Promise<{ board: string; kind: Kind; ref: string }[]> {
  const v = vectors(env);
  if (!v) throw new Error("no vector index is bound");
  const [qv] = await embed(env, [q]);
  const r = await v.query(Array.from(qv), { topK: Math.min(limit, 50), filter: { board: { $in: boards }, ...(kind ? { kind } : {}) }, returnMetadata: "all" });
  const top = r.matches[0]?.score ?? 0;
  return r.matches
    .filter((m) => m.score >= SEMANTIC_FLOOR && m.score >= top - SEMANTIC_MARGIN)
    .map((m) => m.metadata as { board: string; kind: Kind; ref: string })
    .filter((m) => m && typeof m.board === "string" && typeof m.ref === "string");
}

// ---------- the HTTP API ----------

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * GET /api/search?q=…[&mode=hybrid|keyword|semantic][&limit=10][&board=<id or name>][&kind=card|page]
 * The app's search box. Session only; agents search over MCP (the `search` tool).
 */
export async function handleSearch(req: Request, env: Env, path: string): Promise<Response | null> {
  if (path !== "/api/search" || req.method !== "GET") return null;
  const user = await currentUser(req, env);
  if (!user) return json({ error: "signed out" }, 401);
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 500);
  if (!q) return json({ error: "What to look for? Missing ?q=", code: "bad_query" }, 400);
  const mode = url.searchParams.get("mode");
  const kind = url.searchParams.get("kind");
  const only = url.searchParams.get("board") ?? undefined;
  if (only !== undefined && only.length > 80) return json({ error: "No such board.", code: "not_found" }, 404);
  const boards = await reachable(env, user, only);
  if (!boards) return json({ error: "No such board.", code: "not_found" }, 404);
  await ensureIndexed(env, boards);
  const limit = Number(url.searchParams.get("limit"));
  const r = await searchAll(env, boards, {
    query: q,
    mode: mode === "keyword" || mode === "semantic" ? mode : "hybrid",
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    kind: kind === "card" || kind === "page" ? kind : undefined,
  });
  return json(r);
}

/** Is this a board id (not a name)? Names go to `reachable` all the same; this is for callers that want to skip a lookup. */
export const looksLikeBoard = (s: string) => BOARD_ID.test(s);
