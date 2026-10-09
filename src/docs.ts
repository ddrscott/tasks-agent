// Pages and files, one tree per board (// PAGES in the README). A page is a text file (Markdown
// first of all) small enough to live in the board's own SQLite, with its earlier versions kept
// beside it; anything else is bytes in R2 under `<board id>/files/<path>`. Each board gets a
// Docs Durable Object named by the board's id, so a board's pages, members, and cards share one
// id and one access check (`access` in members.ts).
//
// The API is plain enough for a sync client later (etags, a change cursor), but the way in for
// agents is MCP (mcp.ts): read_page, write_page, edit_page, list_pages, delete_page.
//
//   GET    /tasks/api/files?board=<id>[&prefix=docs/]        list, newest change first
//   GET    /tasks/api/files/<path>?board=<id>                 a page as JSON (Accept: application/json), or the file's bytes
//   PUT    /tasks/api/files/<path>?board=<id>                 body = the content; If-Match: <etag> to overwrite, If-None-Match: * to create only
//   DELETE /tasks/api/files/<path>?board=<id>                 If-Match optional
//   POST   /tasks/api/files/move   {board, from, to}
//   GET    /tasks/api/files/<path>/revisions?board=<id>       earlier versions of a page, newest first
//
// A member goes through the membership check the board does: a viewer reads, a writer writes,
// and a board that isn't theirs answers like one that doesn't exist.

import { DurableObject } from "cloudflare:workers";
import { currentUser, type User } from "./auth";
import { boardById, ownedBoard } from "./boards";
import { EXPORT_FORMATS, EXPORT_TYPES, pageDocx, pageHtml, pagePdf, pagesZip, pageTitle, type ExportFormat } from "./export";
import { access, spendBoardCall } from "./members";
import { BOARD_ID, plainText } from "./member-rules";
import { countIndexed, dropBoard, dropEntries, dropPrefix, embed, indexEntries, markIndexed, resetEntries, unmarkIndexed, upsertVectors, type Entry } from "./search-all";
import { sheetFromCsv, Sheets, type QueryResult, type Row as SheetRow, type SheetInfo } from "./sheets";

const MB = 1024 * 1024;
/** The most text a page holds; longer content is a file, stored as bytes. */
export const PAGE_MAX_BYTES = 256 * 1024;
/** Revisions kept per page. */
const REVISIONS_KEPT = 30;
/** The most a board's pages may add up to in SQLite, and its files in R2 (the latter shares ATTACHMENT_QUOTA_MB). */
const PAGES_QUOTA_BYTES = 64 * MB;
const FILE_MAX_MB_DEFAULT = 25;
export const PATH_MAX = 200;

/** Types stored as text, and so readable, editable, and versioned as pages. */
const TEXT_TYPES = new Set(["text/markdown", "text/plain", "text/csv", "application/json", "text/html", "text/yaml", "application/yaml", "text/x-yaml"]);
const EXT_TYPES: Record<string, string> = {
  md: "text/markdown", markdown: "text/markdown", txt: "text/plain", csv: "text/csv", json: "application/json", yaml: "text/yaml", yml: "text/yaml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf",
};
export const isTextType = (t: string) => TEXT_TYPES.has(t);
export const typeForPath = (path: string, given?: string | null): string => {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  if (EXT_TYPES[ext]) return EXT_TYPES[ext];
  const t = (given ?? "").split(";")[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(t) ? t : "application/octet-stream";
};

export type FileInfo = {
  path: string;
  size: number;
  type: string;
  etag: string;
  /** Text pages can be read and edited in place and have revisions. */
  page: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
};
export type Revision = { etag: string; at: string; by: string; size: number };
type Row = { path: string; size: number; type: string; etag: string; is_page: number; created_at: string; created_by: string; updated_at: string; updated_by: string };

/**
 * A path as stored: forward slashes, no leading or trailing slash, no empty, `.`, or `..`
 * pieces, printable characters only, at most PATH_MAX. Case is kept. Null when it can't be one.
 */
export function cleanPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let p: string;
  try { p = decodeURIComponent(raw); } catch { return null; }
  p = plainText(p).replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "").trim();
  if (!p || p.length > PATH_MAX) return null;
  const parts = p.split("/");
  if (parts.some((s) => !s.trim() || s === "." || s === ".." || /[\u0000-\u001f\u007f]/.test(s))) return null;
  return p;
}

const etagOf = async (bytes: Uint8Array): Promise<string> => {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer));
  return [...h.subarray(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
const utf8 = new TextEncoder();
const now = () => new Date().toISOString();
/** What a page is called in search hits: its first Markdown heading, else its file name. */
export function titleOf(path: string, text: string): string {
  const h = text.match(/^#{1,6}[ \t]+(.+?)[ \t#]*$/m);
  return (h?.[1] ?? path.split("/").pop() ?? path).slice(0, 200);
}

export class Docs extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY, size INTEGER NOT NULL, type TEXT NOT NULL, etag TEXT NOT NULL, is_page INTEGER NOT NULL,
      created_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL)`);
    // A page's text, by path. Files that aren't pages have no row here: their bytes are in R2.
    this.sql.exec("CREATE TABLE IF NOT EXISTS pages (path TEXT PRIMARY KEY, text TEXT NOT NULL)");
    // Earlier versions of a page, newest last. Trimmed to REVISIONS_KEPT per path.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, etag TEXT NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL, size INTEGER NOT NULL, text TEXT NOT NULL)`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS revisions_path ON revisions (path, id)");
    // Every change, in order, so a reader can ask "what changed since seq N".
    this.sql.exec(`CREATE TABLE IF NOT EXISTS log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL, etag TEXT)`);
    // The next search over this board asks it to check its pages are in the cross-board index (ensureSearch).
    if (this.board) this.ctx.waitUntil(unmarkIndexed(env, this.board, "page").catch((e: Error) => console.warn("search unmark failed", e.message)));
  }

  /**
   * Check this board's pages are in the cross-board index (search-all.ts), and put them all in
   * when the count is off: pages from before the index existed, or a write that failed. A
   * search calls this once per start of this object (ensureIndexed); then D1 says it's done.
   */
  async ensureSearch(): Promise<void> {
    if (!this.board) return;
    const pages = this.allPages();
    if ((await countIndexed(this.env, this.board, "page")) !== pages.length) {
      await resetEntries(this.env, this.board, "page", pages.map((p) => ({ kind: "page" as const, ref: p.path, title: titleOf(p.path, p.text), body: p.text })));
      if (this.env.VECTORS) await this.indexPages(pages);
    }
    // Worksheet rows ride on the same mark: this object holds both.
    const rowsHeld = this.sheets.list().reduce((n, s) => n + s.rows, 0);
    if ((await countIndexed(this.env, this.board, "row")) !== rowsHeld) await this.indexAllRows();
    await markIndexed(this.env, this.board, "page");
  }

  /** The board this tree belongs to: the object is named by the board's id. */
  private get board(): string {
    return this.ctx.id.name ?? "";
  }

  /** Put pages in the cross-board search (search-all.ts): keyword rows, then a vector each. Failures are logged, not thrown. */
  private async indexPages(pages: { path: string; text: string }[]): Promise<void> {
    if (!pages.length || !this.board) return;
    try {
      await indexEntries(this.env, this.board, pages.map((p) => ({ kind: "page" as const, ref: p.path, title: titleOf(p.path, p.text), body: p.text })));
      if (!this.env.VECTORS) return;
      const vecs = await embed(this.env, pages.map((p) => `${titleOf(p.path, p.text)}\n${p.text}`));
      await upsertVectors(this.env, this.board, pages.map((p, i) => ({ kind: "page" as const, ref: p.path, vec: vecs[i] })));
    } catch (e) {
      console.warn("indexing pages failed", (e as Error).message);
    }
  }
  private unindex(paths: string[]) {
    if (this.board) this.ctx.waitUntil(dropEntries(this.env, this.board, "page", paths).catch((e: Error) => console.warn("unindexing a page failed", e.message)));
  }

  /** Take every page of this board out of the search index (the board is being removed). */
  forgetSearch(): void {
    if (this.board) this.ctx.waitUntil(dropBoard(this.env, this.board, ["page"]).catch((e: Error) => console.warn("forgetting a board's pages failed", e.message)));
  }

  private row(path: string): Row | null {
    return this.sql.exec<Row>("SELECT * FROM files WHERE path = ?", path).toArray()[0] ?? null;
  }
  private info(r: Row): FileInfo {
    return { path: r.path, size: r.size, type: r.type, etag: r.etag, page: !!r.is_page, createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, updatedBy: r.updated_by };
  }
  private logIt(path: string, action: "put" | "delete" | "move", by: string, etag: string | null) {
    this.sql.exec("INSERT INTO log (path, action, at, by, etag) VALUES (?, ?, ?, ?, ?)", path, action, now(), by, etag);
  }

  /** Every file under `prefix` (a folder, or nothing for all), most recently changed first. */
  list(prefix = ""): { files: FileInfo[]; seq: number } {
    const rows = prefix
      ? this.sql.exec<Row>("SELECT * FROM files WHERE path = ? OR path LIKE ? ORDER BY updated_at DESC", prefix, `${prefix}/%`).toArray()
      : this.sql.exec<Row>("SELECT * FROM files ORDER BY updated_at DESC").toArray();
    const seq = this.sql.exec<{ n: number }>("SELECT COALESCE(MAX(seq), 0) AS n FROM log").one().n;
    return { files: rows.map((r) => this.info(r)), seq };
  }

  /** What changed after `seq`: the cursor for a reader keeping a copy. */
  changes(since: number): { seq: number; path: string; action: string; at: string; by: string; etag: string | null }[] {
    return this.sql.exec<{ seq: number; path: string; action: string; at: string; by: string; etag: string | null }>("SELECT * FROM log WHERE seq > ? ORDER BY seq LIMIT 500", since).toArray();
  }

  stat(path: string): FileInfo | null {
    const r = this.row(path);
    return r ? this.info(r) : null;
  }

  /** A page's text with its info, or null when there's no such page (a file that isn't a page answers null too). */
  readPage(path: string): { info: FileInfo; text: string } | null {
    const r = this.row(path);
    if (!r || !r.is_page) return null;
    const t = this.sql.exec<{ text: string }>("SELECT text FROM pages WHERE path = ?", path).toArray()[0];
    return t ? { info: this.info(r), text: t.text } : null;
  }

  private usedBytes(): number {
    return this.sql.exec<{ n: number }>("SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE is_page = 1").one().n;
  }

  /**
   * Write a page. `ifMatch` is the etag the writer last saw: a different one on disk means
   * someone else wrote in between, and the write is refused with the current info so the
   * writer can merge. `"*"` means "only if it doesn't exist yet". Null means "whatever's there".
   */
  async writePage(path: string, text: string, by: string, ifMatch: string | null, type?: string): Promise<{ ok: true; info: FileInfo; created: boolean } | { ok: false; code: "conflict" | "exists" | "too_big" | "not_page" | "quota"; info: FileInfo | null }> {
    const bytes = utf8.encode(text);
    if (bytes.length > PAGE_MAX_BYTES) return { ok: false, code: "too_big", info: null };
    const was = this.row(path);
    if (was && !was.is_page) return { ok: false, code: "not_page", info: this.info(was) };
    if (ifMatch === "*" && was) return { ok: false, code: "exists", info: this.info(was) };
    if (ifMatch && ifMatch !== "*" && (!was || was.etag !== ifMatch)) return { ok: false, code: "conflict", info: was ? this.info(was) : null };
    if (this.usedBytes() - (was?.size ?? 0) + bytes.length > PAGES_QUOTA_BYTES) return { ok: false, code: "quota", info: was ? this.info(was) : null };
    const etag = await etagOf(bytes);
    const at = now();
    if (was && was.etag === etag) return { ok: true, info: this.info(was), created: false }; // nothing changed
    if (was) {
      const old = this.sql.exec<{ text: string }>("SELECT text FROM pages WHERE path = ?", path).toArray()[0]?.text ?? "";
      this.sql.exec("INSERT INTO revisions (path, etag, at, by, size, text) VALUES (?, ?, ?, ?, ?, ?)", path, was.etag, was.updated_at, was.updated_by, was.size, old);
      this.sql.exec("DELETE FROM revisions WHERE path = ? AND id NOT IN (SELECT id FROM revisions WHERE path = ? ORDER BY id DESC LIMIT ?)", path, path, REVISIONS_KEPT);
      this.sql.exec("UPDATE files SET size = ?, etag = ?, updated_at = ?, updated_by = ? WHERE path = ?", bytes.length, etag, at, by, path);
      this.sql.exec("UPDATE pages SET text = ? WHERE path = ?", text, path);
    } else {
      const kind = type && isTextType(type) ? type : typeForPath(path, type);
      this.sql.exec("INSERT INTO files (path, size, type, etag, is_page, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)",
        path, bytes.length, isTextType(kind) ? kind : "text/plain", etag, at, by, at, by);
      this.sql.exec("INSERT INTO pages (path, text) VALUES (?, ?)", path, text);
    }
    this.logIt(path, "put", by, etag);
    this.ctx.waitUntil(this.indexPages([{ path, text }]));
    return { ok: true, info: this.info(this.row(path)!), created: !was };
  }

  /** Record a file whose bytes the Worker just put in R2 (putFile in this module). Replaces a page of the same path. */
  noteFile(path: string, size: number, type: string, etag: string, by: string, ifMatch: string | null): { ok: true; info: FileInfo } | { ok: false; code: "conflict" | "exists"; info: FileInfo | null } {
    const was = this.row(path);
    if (ifMatch === "*" && was) return { ok: false, code: "exists", info: this.info(was) };
    if (ifMatch && ifMatch !== "*" && (!was || was.etag !== ifMatch)) return { ok: false, code: "conflict", info: was ? this.info(was) : null };
    const at = now();
    if (was) {
      this.sql.exec("UPDATE files SET size = ?, type = ?, etag = ?, is_page = 0, updated_at = ?, updated_by = ? WHERE path = ?", size, type, etag, at, by, path);
      this.sql.exec("DELETE FROM pages WHERE path = ?", path);
      if (was.is_page) this.unindex([path]);
    } else {
      this.sql.exec("INSERT INTO files (path, size, type, etag, is_page, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)", path, size, type, etag, at, by, at, by);
    }
    this.logIt(path, "put", by, etag);
    return { ok: true, info: this.info(this.row(path)!) };
  }

  /** Take a file out. A page's revisions stay until the path is written again, so a deleted page can be read back from them. Returns what was there. */
  remove(path: string, by: string, ifMatch: string | null): { ok: true; info: FileInfo } | { ok: false; code: "conflict" | "missing"; info: FileInfo | null } {
    const was = this.row(path);
    if (!was) return { ok: false, code: "missing", info: null };
    if (ifMatch && ifMatch !== "*" && was.etag !== ifMatch) return { ok: false, code: "conflict", info: this.info(was) };
    if (was.is_page) {
      const old = this.sql.exec<{ text: string }>("SELECT text FROM pages WHERE path = ?", path).toArray()[0]?.text ?? "";
      this.sql.exec("INSERT INTO revisions (path, etag, at, by, size, text) VALUES (?, ?, ?, ?, ?, ?)", path, was.etag, was.updated_at, was.updated_by, was.size, old);
      this.sql.exec("DELETE FROM pages WHERE path = ?", path);
      this.unindex([path]);
    }
    this.sql.exec("DELETE FROM files WHERE path = ?", path);
    this.logIt(path, "delete", by, null);
    return { ok: true, info: this.info(was) };
  }

  /** Rename or move. The bytes of a file that isn't a page are moved in R2 by the Worker first. */
  move(from: string, to: string, by: string): { ok: true; info: FileInfo } | { ok: false; code: "missing" | "exists" } {
    const was = this.row(from);
    if (!was) return { ok: false, code: "missing" };
    if (this.row(to)) return { ok: false, code: "exists" };
    const at = now();
    this.sql.exec("UPDATE files SET path = ?, updated_at = ?, updated_by = ? WHERE path = ?", to, at, by, from);
    this.sql.exec("UPDATE pages SET path = ? WHERE path = ?", to, from);
    this.sql.exec("UPDATE revisions SET path = ? WHERE path = ?", to, from);
    this.logIt(from, "delete", by, null);
    this.logIt(to, "move", by, was.etag);
    if (was.is_page) {
      this.unindex([from]);
      const text = this.sql.exec<{ text: string }>("SELECT text FROM pages WHERE path = ?", to).toArray()[0]?.text;
      if (text !== undefined) this.ctx.waitUntil(this.indexPages([{ path: to, text }]));
    }
    return { ok: true, info: this.info(this.row(to)!) };
  }

  revisions(path: string): Revision[] {
    return this.sql.exec<Revision>("SELECT etag, at, by, size FROM revisions WHERE path = ? ORDER BY id DESC", path).toArray();
  }

  revision(path: string, etag: string): { text: string; at: string; by: string } | null {
    return this.sql.exec<{ text: string; at: string; by: string }>("SELECT text, at, by FROM revisions WHERE path = ? AND etag = ? ORDER BY id DESC LIMIT 1", path, etag).toArray()[0] ?? null;
  }

  /** Every page's path and text, for an index (search.ts, later) or an export. */
  allPages(): { path: string; text: string }[] {
    return this.sql.exec<{ path: string; text: string }>("SELECT path, text FROM pages ORDER BY path").toArray();
  }

  // ---------- worksheets (sheets.ts): typed tables in this same SQLite, so a query can join them ----------

  private _sheets?: Sheets;
  private get sheets(): Sheets {
    return (this._sheets ??= new Sheets(this.ctx.storage));
  }
  sheetList(): SheetInfo[] { return this.sheets.list(); }
  sheetGet(key: string): SheetInfo | null { return this.sheets.get(key); }
  sheetCreate(name: unknown, columns: unknown, by: string): SheetInfo { return this.sheets.create(name, columns, by); }
  sheetImport(name: unknown, csv: unknown, by: string): { sheet: SheetInfo; rows: number } { return sheetFromCsv(this.sheets, name, csv, by); }
  sheetRename(key: string, name: unknown, by: string): SheetInfo {
    const s = this.sheets.rename(key, name, by);
    this.ctx.waitUntil(this.indexSheet(s.id).catch((e: Error) => console.warn("indexing a renamed worksheet failed", e.message)));
    return s;
  }
  sheetRemove(key: string, by: string): SheetInfo {
    const s = this.sheets.remove(key, by);
    if (this.board) this.ctx.waitUntil(dropPrefix(this.env, this.board, "row", `${s.id}/`).catch((e: Error) => console.warn("unindexing a worksheet failed", e.message)));
    return s;
  }
  sheetAddColumn(key: string, name: unknown, type: unknown, by: string): SheetInfo { return this.sheets.addColumn(key, name, type, by); }
  sheetChangeColumn(key: string, col: string, change: { name?: unknown; pos?: unknown }, by: string): SheetInfo { return this.sheets.changeColumn(key, col, change, by); }
  sheetDropColumn(key: string, col: string, by: string): SheetInfo { return this.sheets.dropColumn(key, col, by); }
  sheetRows(key: string, opts: { limit?: number; offset?: number; sort?: string; dir?: string } = {}): { sheet: SheetInfo; rows: SheetRow[]; total: number } { return this.sheets.rows(key, opts); }
  sheetInsert(key: string, rows: unknown, by: string): { sheet: SheetInfo; ids: number[] } {
    const r = this.sheets.insert(key, rows, by);
    this.ctx.waitUntil(this.indexRows(r.sheet.id, r.ids).catch((e: Error) => console.warn("indexing rows failed", e.message)));
    return r;
  }
  sheetUpdate(key: string, updates: unknown, by: string): { sheet: SheetInfo; changed: number } {
    const r = this.sheets.update(key, updates, by);
    const ids = Array.isArray(updates) ? updates.map((u) => Number((u as { id?: unknown })?.id)).filter(Number.isInteger) : [];
    this.ctx.waitUntil(this.indexRows(r.sheet.id, ids).catch((e: Error) => console.warn("indexing rows failed", e.message)));
    return r;
  }
  sheetDeleteRows(key: string, ids: unknown, by: string): { sheet: SheetInfo; deleted: number } {
    const r = this.sheets.deleteRows(key, ids, by);
    const gone = Array.isArray(ids) ? ids.map(Number).filter(Number.isInteger) : [];
    if (this.board) this.ctx.waitUntil(dropEntries(this.env, this.board, "row", gone.map((id) => `${r.sheet.id}/${id}`)).catch((e: Error) => console.warn("unindexing rows failed", e.message)));
    return r;
  }
  sheetQuery(sql: unknown, limit?: unknown): QueryResult { return this.sheets.query(sql, limit); }

  /** Rows in the cross-board search (search-all.ts, kind `row`): ref `<sheet id>/<row id>`, the first text cell as the title, every cell in the body. Keyword only; rows carry no vectors. */
  private rowEntries(sheet: SheetInfo, rows: SheetRow[]): Entry[] {
    const textCol = sheet.columns.find((c) => c.type === "text" || c.type === "link");
    return rows.map((r) => {
      const first = textCol ? r[textCol.name] : null;
      const title = first !== null && first !== undefined && String(first).trim() ? String(first).slice(0, 200) : `Row ${r._id}`;
      const body = sheet.columns.map((c) => `${c.name}: ${r[c.name] ?? ""}`).join("\n");
      return { kind: "row", ref: `${sheet.id}/${r._id}`, title, body, meta: { sheet: sheet.name, sheetId: sheet.id } };
    });
  }
  private async indexRows(sheetId: string, ids: number[]): Promise<void> {
    if (!this.board || !ids.length) return;
    const { sheet, rows } = this.sheets.byIds(sheetId, ids);
    await indexEntries(this.env, this.board, this.rowEntries(sheet, rows));
  }
  /** Every row of one sheet again (after a rename, the title's sheet name changes). */
  private async indexSheet(sheetId: string): Promise<void> {
    if (!this.board) return;
    const info = this.sheets.get(sheetId);
    if (!info) return;
    await dropPrefix(this.env, this.board, "row", `${sheetId}/`);
    for (let off = 0; off < info.rows; off += 500) {
      const { rows } = this.sheets.rows(sheetId, { limit: 500, offset: off });
      await indexEntries(this.env, this.board, this.rowEntries(info, rows));
    }
  }
  /** Every row of every sheet, when the count is off (ensureSearch). */
  private async indexAllRows(): Promise<void> {
    if (!this.board) return;
    await this.env.DB.prepare("DELETE FROM search_fts WHERE board = ? AND kind = 'row'").bind(this.board).run();
    for (const s of this.sheets.list()) {
      for (let off = 0; off < s.rows; off += 500) {
        const { rows } = this.sheets.rows(s.id, { limit: 500, offset: off });
        await indexEntries(this.env, this.board, this.rowEntries(s, rows));
      }
    }
  }
}

// ---------- the HTTP API ----------

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}) => json({ error, code, ...extra }, status);
const notFound = () => fail(404, "not_found", "No such board.");

/** Whose files, and may the caller write them. Null for no way in. The same answers attachments give (attachments.ts). */
export async function fileAccess(env: Env, user: User, boardKey: string | null): Promise<{ board: string; write: boolean; email: string; member: boolean } | Response | null> {
  const board = boardKey ?? user.id;
  if (!BOARD_ID.test(board)) return null;
  if (board === user.id || (await ownedBoard(env, user, board))) return { board, write: true, email: user.email, member: false };
  const slow = spendBoardCall(user.id);
  if (slow) return slow;
  const a = await access(env, user, board);
  if (a.effective !== "viewer" && a.effective !== "writer") return null;
  return { board, write: a.effective === "writer", email: user.email, member: true };
}

const readOnly = () => fail(403, "read_only", "You can view this board, not change it.");
const docsOf = (env: Env, board: string) => env.Docs.get(env.Docs.idFromName(board));
const fileKey = (board: string, path: string) => `${board}/files/${path}`;

async function putFile(req: Request, env: Env, who: { board: string; email: string }, path: string, ifMatch: string | null): Promise<Response> {
  const size = Number(req.headers.get("Content-Length"));
  const max = (Number(env.ATTACHMENT_MAX_MB) > 0 ? Number(env.ATTACHMENT_MAX_MB) : FILE_MAX_MB_DEFAULT) * MB;
  if (!req.body || !Number.isFinite(size) || size < 0) return fail(400, "empty", "Send the file as the request body with its length.");
  if (size > max) return fail(413, "too_big", `Files can be up to ${max / MB} MB.`);
  const type = typeForPath(path, req.headers.get("Content-Type"));
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length !== size) return fail(400, "short", "The body wasn't as long as Content-Length said.");
  const docs = docsOf(env, who.board);
  // Small text goes in as a page, whatever the request said: pages are what agents read and edit.
  if (isTextType(type) && bytes.length <= PAGE_MAX_BYTES) {
    const r = await docs.writePage(path, new TextDecoder().decode(bytes), who.email, ifMatch, type);
    return r.ok ? json({ file: r.info }, r.created ? 201 : 200, { ETag: r.info.etag }) : refusal(r);
  }
  const etag = await etagOf(bytes);
  await env.ATTACHMENTS.put(fileKey(who.board, path), bytes, { httpMetadata: { contentType: type }, customMetadata: { path } });
  const r = await docs.noteFile(path, bytes.length, type, etag, who.email, ifMatch);
  if (!r.ok) { await env.ATTACHMENTS.delete(fileKey(who.board, path)).catch(() => {}); return refusal(r); }
  return json({ file: r.info }, 201, { ETag: r.info.etag });
}

function refusal(r: { ok: false; code: string; info: FileInfo | null }): Response {
  switch (r.code) {
    case "conflict": return fail(412, "conflict", "Someone changed this page since you read it. Read it again and merge your change.", { file: r.info });
    case "exists": return fail(412, "exists", "There's already a file at that path.", { file: r.info });
    case "too_big": return fail(413, "too_big", `A page can be up to ${PAGE_MAX_BYTES / 1024} KB of text. Longer content is a file.`);
    case "not_page": return fail(409, "not_page", "That path is a file, not a page. Delete it first, or pick another path.", { file: r.info });
    case "quota": return fail(413, "quota", `This board's pages are at their ${PAGES_QUOTA_BYTES / MB} MB. Delete some first.`);
    case "missing": return fail(404, "missing", "There's no file at that path.");
    default: return fail(400, r.code, "That didn't work.");
  }
}

/**
 * A page in another format (export.ts). HTML is served inline when asked (`inline=1`, for the
 * app's Print button, which opens it and calls print) and as a download otherwise; it's our
 * renderer's output, with no script, under a policy that allows none. PDF needs the browser
 * binding and says so without it.
 */
async function exportPage(env: Env, w: { board: string; email: string }, path: string, page: { info: FileInfo; text: string }, format: ExportFormat, inline: boolean): Promise<Response> {
  const base = path.split("/").pop()!.replace(/\.[a-z0-9]+$/i, "").replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  const ownerName = (await ownedBoard(env, { id: w.board, email: w.email }, w.board))?.name ?? (await boardById(env, w.board))?.name ?? "Tasks";
  const html = pageHtml(path, page.text, { board: ownerName, by: page.info.updatedBy, at: page.info.updatedAt });
  const headers = (type: string, ext: string, dispo: "inline" | "attachment") => ({
    "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `${dispo}; filename="${base}.${ext}"; filename*=UTF-8''${encodeURIComponent(`${pageTitle(path, page.text)}.${ext}`)}`,
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:",
  });
  if (format === "html") return new Response(html, { headers: headers(EXPORT_TYPES.html, "html", inline ? "inline" : "attachment") });
  if (format === "docx") return new Response(pageDocx(path, page.text) as BodyInit, { headers: headers(EXPORT_TYPES.docx, "docx", "attachment") });
  const pdf = await pagePdf(env, html);
  if (!pdf) return fail(501, "no_pdf", "PDF export isn't set up on this server. Open the HTML export and print it to PDF; the Print button does that.");
  return new Response(pdf as BodyInit, { headers: headers(EXPORT_TYPES.pdf, "pdf", inline ? "inline" : "attachment") });
}

/** /api/files routes. Session only: agents read and write pages over MCP (mcp.ts). */
export async function handleFiles(req: Request, env: Env, path: string): Promise<Response | null> {
  if (path !== "/api/files" && !path.startsWith("/api/files/")) return null;
  const user = await currentUser(req, env);
  if (!user) return json({ error: "signed out" }, 401);
  const url = new URL(req.url);

  if (path === "/api/files/move" && req.method === "POST") {
    const raw = await req.json<unknown>().catch(() => null);
    const body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const w = await fileAccess(env, user, typeof body.board === "string" ? body.board : null);
    if (!w) return notFound();
    if (w instanceof Response) return w;
    if (!w.write) return readOnly();
    const from = cleanPath(body.from);
    const to = cleanPath(body.to);
    if (!from || !to) return fail(400, "bad_path", "Paths use forward slashes, no leading slash, and no .. pieces.");
    const docs = docsOf(env, w.board);
    const info = await docs.stat(from);
    if (!info) return refusal({ ok: false, code: "missing", info: null });
    if (!info.page) {
      const obj = await env.ATTACHMENTS.get(fileKey(w.board, from));
      if (obj) await env.ATTACHMENTS.put(fileKey(w.board, to), obj.body, { httpMetadata: obj.httpMetadata, customMetadata: { path: to } });
    }
    const r = await docs.move(from, to, w.email);
    if (!r.ok) return refusal({ ...r, info: null });
    if (!info.page) await env.ATTACHMENTS.delete(fileKey(w.board, from)).catch(() => {});
    return json({ file: r.info });
  }

  const w = await fileAccess(env, user, url.searchParams.get("board"));
  if (!w) return notFound();
  if (w instanceof Response) return w;
  const docs = docsOf(env, w.board);

  if (path === "/api/files") {
    if (req.method !== "GET") return null;
    const since = Number(url.searchParams.get("since"));
    if (Number.isFinite(since) && url.searchParams.has("since")) return json({ changes: await docs.changes(since) });
    const prefix = cleanPath(url.searchParams.get("prefix") ?? "") ?? "";
    // A folder's pages as a zip (// EXPORT): the Markdown as written, or each page as HTML.
    if (url.searchParams.get("format") === "zip") {
      const as = url.searchParams.get("as") === "html" ? "html" : "md";
      const pages = (await docs.allPages()).filter((p) => !prefix || p.path === prefix || p.path.startsWith(`${prefix}/`));
      if (!pages.length) return refusal({ ok: false, code: "missing", info: null });
      const name = `${(prefix || "pages").replace(/[^\w.-]+/g, "_")}.zip`;
      return new Response(pagesZip(pages, as) as BodyInit, { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" } });
    }
    return json(await docs.list(prefix));
  }

  let sub = path.slice("/api/files/".length);
  const revisions = sub.endsWith("/revisions");
  if (revisions) sub = sub.slice(0, -"/revisions".length);
  const file = cleanPath(sub);
  if (!file) return fail(400, "bad_path", "Paths use forward slashes, no leading slash, and no .. pieces.");

  if (req.method === "GET") {
    if (revisions) {
      const etag = url.searchParams.get("rev");
      if (etag) {
        const rev = await docs.revision(file, etag);
        return rev ? json({ path: file, etag, ...rev }) : refusal({ ok: false, code: "missing", info: null });
      }
      return json({ path: file, revisions: await docs.revisions(file) });
    }
    const info = await docs.stat(file);
    if (!info) return refusal({ ok: false, code: "missing", info: null });
    if (info.page) {
      const page = await docs.readPage(file);
      if (!page) return refusal({ ok: false, code: "missing", info: null });
      // An export (export.ts, // EXPORT): the page as HTML, a Word document, or a PDF.
      const format = url.searchParams.get("format");
      if (format) {
        if (!EXPORT_FORMATS.includes(format as ExportFormat)) return fail(400, "bad_format", `format is one of ${EXPORT_FORMATS.join(", ")}.`);
        return exportPage(env, w, file, page, format as ExportFormat, url.searchParams.get("inline") === "1");
      }
      if ((req.headers.get("Accept") ?? "").includes("application/json")) return json({ file: page.info, text: page.text }, 200, { ETag: page.info.etag });
      return new Response(page.text, { headers: { "Content-Type": `${info.type}; charset=utf-8`, ETag: info.etag, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" } });
    }
    const obj = await env.ATTACHMENTS.get(fileKey(w.board, file));
    if (!obj) return refusal({ ok: false, code: "missing", info: null });
    const inline = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"].includes(info.type) && url.searchParams.get("download") !== "1";
    const name = file.split("/").pop()!;
    const headers = new Headers({
      "Content-Type": inline ? info.type : "application/octet-stream", "Content-Length": String(obj.size), ETag: info.etag,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "X-Content-Type-Options": "nosniff", "Cache-Control": w.member ? "no-store" : "private, max-age=3600",
    });
    if (info.type !== "application/pdf") headers.set("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    return new Response(obj.body, { headers });
  }

  if (!w.write) return readOnly();
  const ifMatch = req.headers.get("If-None-Match") === "*" ? "*" : (req.headers.get("If-Match")?.replace(/^W\//, "").replace(/"/g, "") ?? null);
  if (req.method === "PUT") return putFile(req, env, w, file, ifMatch);
  if (req.method === "DELETE") {
    const r = await docs.remove(file, w.email, ifMatch);
    if (!r.ok) return refusal(r);
    if (!r.info.page) await env.ATTACHMENTS.delete(fileKey(w.board, file)).catch(() => {});
    return json({ file: r.info, deleted: true });
  }
  return null;
}
