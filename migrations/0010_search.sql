-- Search across boards (src/search-all.ts). One FTS5 table holds a row per card and per page
-- on every board that isn't encrypted, keyed by the board's id, so "everything I can reach"
-- is one query over the ids the caller owns or is a member of. Each board's Durable Object
-- writes its own rows as things change (TodoAgent.reindex, Docs.writePage), so the rows are
-- a copy of what the boards hold, never the source: a board that re-indexes rewrites them.
--
-- kind is 'card' or 'page'; ref is the card's id or the page's path. meta is JSON a hit
-- shows without going back to the board (a card's lane, due date, and assignee).
--
-- Meaning-based search goes to Vectorize, which has a vector index and D1 doesn't; the
-- keyword side lives here because FTS5 is built into SQLite, and so into D1.
CREATE VIRTUAL TABLE search_fts USING fts5(
  board UNINDEXED, kind UNINDEXED, ref UNINDEXED, meta UNINDEXED, title, body,
  tokenize = 'porter unicode61 remove_diacritics 2'
);
-- Which boards have put their rows in, per kind (a board's cards and its pages are two
-- objects). A search over a board with no row here wakes that object first, so a board from
-- before the index existed is in it the first time anyone searches, not the first time
-- someone happens to open it.
CREATE TABLE search_boards (
  board TEXT NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (board, kind)
);
