// Worksheets (// WORKSHEETS in the README): typed tables on a board that people edit in a
// grid and agents read, write, and query with SQL over MCP. A worksheet is a real SQLite
// table in the board's Docs Durable Object, named by the sheet's name, with a column per
// typed column (text, number, date, checkbox, link) and three of the table's own: `_id`,
// `_at`, and `_by`, so every row says who last changed it and when. `query` runs one
// read-only SELECT against those tables, inside a transaction that's always rolled back, so
// a statement that writes anyway changes nothing.
//
// The catalog (`sheets`, `sheet_cols`) is the source for names and types; the tables hold
// the rows. Renaming a sheet or a column is an ALTER TABLE, so a query written against the
// new name works at once. Every row change is logged (`sheet_log`) with what it replaced.
//
//   GET    /tasks/api/sheets?board=<id>                        the sheets, with columns and row counts
//   POST   /tasks/api/sheets                 {board, name, columns: [{name, type}]}
//   POST   /tasks/api/sheets/import          {board, name, csv}  a new sheet from CSV, types inferred
//   POST   /tasks/api/sheets/query           {board, sql, limit}
//   GET    /tasks/api/sheets/<id>?board=&limit=&offset=&sort=&dir=
//   GET    /tasks/api/sheets/<id>/export?board=                 text/csv
//   POST   /tasks/api/sheets/<id>/rename     {board, name}
//   DELETE /tasks/api/sheets/<id>?board=
//   POST   /tasks/api/sheets/<id>/rows       {board, rows: [{<column>: value}]}
//   PATCH  /tasks/api/sheets/<id>/rows       {board, updates: [{id, cells: {<column>: value}}]}
//   DELETE /tasks/api/sheets/<id>/rows       {board, ids}
//   POST   /tasks/api/sheets/<id>/columns    {board, name, type}
//   PATCH  /tasks/api/sheets/<id>/columns/<col>  {board, name?, pos?}
//   DELETE /tasks/api/sheets/<id>/columns/<col>?board=

import { currentUser } from "./auth";
import { fileAccess } from "./docs";
import { plainText } from "./member-rules";

import { COLUMN_TYPES, type Cell, type Column, type ColumnType, type QueryResult, type Row, type SheetInfo } from "./sheets-shared";
export { COLUMN_TYPES, type Cell, type Column, type ColumnType, type QueryResult, type Row, type SheetInfo };

export const SHEET_NAME_MAX = 60;
export const COLUMN_NAME_MAX = 40;
export const COLUMNS_MAX = 60;
export const ROWS_MAX = 50_000;
export const ROWS_PER_CALL = 1000;
export const CELL_MAX = 10_000;
export const QUERY_ROWS_DEFAULT = 200;
export const QUERY_ROWS_MAX = 2000;
const LOG_KEPT = 5000;
/** Tables of the Docs object's own that a sheet can't be called, so its table can't collide. */
const RESERVED = new Set(["files", "pages", "revisions", "log", "meta", "sheets", "sheet_cols", "sheet_log", "_file_extracts", "_file_extract_text"]);

export type SheetCode = "bad_name" | "exists" | "missing" | "bad_column" | "bad_value" | "too_many" | "bad_query";
/**
 * A refusal with a code. It crosses the Durable Object RPC boundary as a plain Error, so the
 * code rides in the message (`[code] text`) and `sheetRefusal` reads it back on the other side.
 */
export class SheetError extends Error {
  constructor(public code: SheetCode, text: string) {
    super(`[${code}] ${text}`);
  }
}
/** The code and text of a SheetError, from the error itself or its message after an RPC hop; null for any other error. */
export function sheetRefusal(e: unknown): { code: SheetCode; text: string } | null {
  const m = /^\[(bad_name|exists|missing|bad_column|bad_value|too_many|bad_query)\] ([\s\S]*)$/.exec(e instanceof Error ? e.message : "");
  return m ? { code: m[1] as SheetCode, text: m[2] } : null;
}

/** A sheet or column name as stored: trimmed, single spaces, printable, no quotes. Null when it can't be one. */
export function cleanName(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const s = plainText(raw).replace(/\s+/g, " ").trim();
  if (!s || s.length > max || /["\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const newId = (p: string) => p + Math.random().toString(36).slice(2, 7).padEnd(5, "0");
const now = () => new Date().toISOString();
const SQL_TYPE: Record<ColumnType, string> = { text: "TEXT", number: "REAL", date: "TEXT", checkbox: "INTEGER", link: "TEXT" };

/** A cell as stored, by its column's type. Throws a SheetError naming the column on a value that can't be. */
export function coerce(col: { name: string; type: ColumnType }, v: unknown): Cell {
  if (v === null || v === undefined || v === "") return null;
  switch (col.type) {
    case "number": {
      const n = typeof v === "number" ? v : typeof v === "boolean" ? Number(v) : Number(String(v).trim().replace(/^\$/, "").replace(/,/g, ""));
      if (!Number.isFinite(n)) throw new SheetError("bad_value", `"${col.name}" is a number column; "${String(v).slice(0, 40)}" isn't a number.`);
      return n;
    }
    case "checkbox": {
      if (typeof v === "boolean") return v ? 1 : 0;
      if (typeof v === "number") return v ? 1 : 0;
      const s = String(v).trim().toLowerCase();
      if (["1", "true", "yes", "y", "x", "on", "done", "checked"].includes(s)) return 1;
      if (["0", "false", "no", "n", "off", "", "-"].includes(s)) return 0;
      throw new SheetError("bad_value", `"${col.name}" is a checkbox column; "${String(v).slice(0, 40)}" isn't yes or no.`);
    }
    case "date": {
      const s = String(v).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))) return s;
      const t = Date.parse(s);
      if (Number.isNaN(t)) throw new SheetError("bad_value", `"${col.name}" is a date column; "${s.slice(0, 40)}" isn't a date. Use YYYY-MM-DD.`);
      return new Date(t).toISOString().slice(0, 10);
    }
    default: {
      const s = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
      return plainText(s).slice(0, CELL_MAX);
    }
  }
}

/** Guess a column's type from its values: every value a number, a date, or yes/no, else text. */
export function inferType(values: unknown[]): ColumnType {
  const vs = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== "");
  if (!vs.length) return "text";
  const all = (t: ColumnType) => vs.every((v) => { try { coerce({ name: "", type: t }, v); return true; } catch { return false; } });
  if (all("number")) return "number";
  if (vs.every((v) => /^\d{4}-\d{2}-\d{2}/.test(String(v).trim())) && all("date")) return "date";
  if (vs.every((v) => /^(true|false|yes|no|x|y|n|1|0)$/i.test(String(v).trim())) && all("checkbox")) return "checkbox";
  if (vs.every((v) => /^https?:\/\/\S+$/.test(String(v).trim()))) return "link";
  return "text";
}

type SheetRow = { id: string; name: string; created_at: string; created_by: string; updated_at: string; updated_by: string };
type ColRow = { sheet_id: string; id: string; name: string; type: ColumnType; pos: number };

/** The worksheets of one board, in its Docs object's SQLite. */
export class Sheets {
  private sql: SqlStorage;
  constructor(private storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sheets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sheet_cols (
      sheet_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, pos INTEGER NOT NULL, PRIMARY KEY (sheet_id, id))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sheet_log (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, sheet_id TEXT NOT NULL, row_id INTEGER, action TEXT NOT NULL, before TEXT, after TEXT, by TEXT NOT NULL, at TEXT NOT NULL)`);
  }

  private sheetRow(key: string): SheetRow | null {
    return this.sql.exec<SheetRow>("SELECT * FROM sheets WHERE id = ? OR name = ? COLLATE NOCASE", key, key).toArray()[0] ?? null;
  }
  private cols(sheetId: string): Column[] {
    return this.sql.exec<ColRow>("SELECT * FROM sheet_cols WHERE sheet_id = ? ORDER BY pos", sheetId).toArray().map((c) => ({ id: c.id, name: c.name, type: c.type, pos: c.pos }));
  }
  private count(name: string): number {
    return this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${ident(name)}`).one().n;
  }
  private info(s: SheetRow): SheetInfo {
    return { id: s.id, name: s.name, columns: this.cols(s.id), rows: this.count(s.name), createdAt: s.created_at, createdBy: s.created_by, updatedAt: s.updated_at, updatedBy: s.updated_by };
  }
  private touch(id: string, by: string) {
    this.sql.exec("UPDATE sheets SET updated_at = ?, updated_by = ? WHERE id = ?", now(), by, id);
  }
  private logIt(sheetId: string, rowId: number | null, action: string, before: unknown, after: unknown, by: string) {
    this.sql.exec("INSERT INTO sheet_log (sheet_id, row_id, action, before, after, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      sheetId, rowId, action, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after), by, now());
    this.sql.exec("DELETE FROM sheet_log WHERE sheet_id = ? AND seq NOT IN (SELECT seq FROM sheet_log WHERE sheet_id = ? ORDER BY seq DESC LIMIT ?)", sheetId, sheetId, LOG_KEPT);
  }
  /** The sheet `key` names (id or name, case aside), or a SheetError. */
  private need(key: string): SheetRow {
    const s = this.sheetRow(key);
    if (!s) throw new SheetError("missing", `There's no worksheet called "${key.slice(0, 60)}".`);
    return s;
  }
  private column(sheetId: string, key: string): Column {
    const c = this.cols(sheetId).find((x) => x.id === key || x.name.toLowerCase() === key.toLowerCase());
    if (!c) throw new SheetError("bad_column", `There's no column "${key.slice(0, 40)}" on this worksheet.`);
    return c;
  }

  list(): SheetInfo[] {
    return this.sql.exec<SheetRow>("SELECT * FROM sheets ORDER BY name COLLATE NOCASE").toArray().map((s) => this.info(s));
  }

  get(key: string): SheetInfo | null {
    const s = this.sheetRow(key);
    return s ? this.info(s) : null;
  }

  create(rawName: unknown, rawColumns: unknown, by: string): SheetInfo {
    const name = cleanName(rawName, SHEET_NAME_MAX);
    if (!name || RESERVED.has(name.toLowerCase()) || /^sqlite_/i.test(name)) throw new SheetError("bad_name", `A worksheet name is 1 to ${SHEET_NAME_MAX} characters, no quotes.`);
    if (this.sheetRow(name)) throw new SheetError("exists", `There's already a worksheet called "${name}".`);
    const columns = this.cleanColumns(rawColumns);
    if (!columns.length) throw new SheetError("bad_column", "A worksheet needs at least one column: [{name, type}], with type text, number, date, checkbox, or link.");
    const id = newId("s");
    const at = now();
    return this.storage.transactionSync(() => {
      this.sql.exec(`CREATE TABLE ${ident(name)} (_id INTEGER PRIMARY KEY AUTOINCREMENT, _at TEXT NOT NULL, _by TEXT NOT NULL${columns.map((c) => `, ${ident(c.name)} ${SQL_TYPE[c.type]}`).join("")})`);
      this.sql.exec("INSERT INTO sheets (id, name, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)", id, name, at, by, at, by);
      columns.forEach((c, i) => this.sql.exec("INSERT INTO sheet_cols (sheet_id, id, name, type, pos) VALUES (?, ?, ?, ?, ?)", id, newId("k"), c.name, c.type, i));
      this.logIt(id, null, "create", undefined, { name, columns }, by);
      return this.info(this.sheetRow(id)!);
    });
  }

  private cleanColumns(raw: unknown): { name: string; type: ColumnType }[] {
    if (!Array.isArray(raw)) return [];
    const out: { name: string; type: ColumnType }[] = [];
    const seen = new Set<string>();
    for (const c of raw.slice(0, COLUMNS_MAX)) {
      const spec = typeof c === "string" ? { name: c, type: "text" } : (c ?? {}) as { name?: unknown; type?: unknown };
      const name = cleanName(spec.name, COLUMN_NAME_MAX);
      if (!name || name.startsWith("_")) throw new SheetError("bad_column", `A column name is 1 to ${COLUMN_NAME_MAX} characters, no quotes, not starting with _ ("${String(spec.name).slice(0, 40)}").`);
      if (seen.has(name.toLowerCase())) throw new SheetError("bad_column", `Two columns are both called "${name}".`);
      seen.add(name.toLowerCase());
      const type = (typeof spec.type === "string" ? spec.type.toLowerCase() : "text") as ColumnType;
      if (!COLUMN_TYPES.includes(type)) throw new SheetError("bad_column", `Column "${name}" has type "${String(spec.type).slice(0, 20)}"; types are ${COLUMN_TYPES.join(", ")}.`);
      out.push({ name, type });
    }
    return out;
  }

  rename(key: string, rawName: unknown, by: string): SheetInfo {
    const s = this.need(key);
    const name = cleanName(rawName, SHEET_NAME_MAX);
    if (!name || RESERVED.has(name.toLowerCase()) || /^sqlite_/i.test(name)) throw new SheetError("bad_name", `A worksheet name is 1 to ${SHEET_NAME_MAX} characters, no quotes.`);
    if (name === s.name) return this.info(s);
    const taken = this.sheetRow(name);
    if (taken && taken.id !== s.id) throw new SheetError("exists", `There's already a worksheet called "${name}".`);
    return this.storage.transactionSync(() => {
      this.sql.exec(`ALTER TABLE ${ident(s.name)} RENAME TO ${ident(name)}`);
      this.sql.exec("UPDATE sheets SET name = ?, updated_at = ?, updated_by = ? WHERE id = ?", name, now(), by, s.id);
      this.logIt(s.id, null, "rename", { name: s.name }, { name }, by);
      return this.info(this.sheetRow(s.id)!);
    });
  }

  remove(key: string, by: string): SheetInfo {
    const s = this.need(key);
    const was = this.info(s);
    this.storage.transactionSync(() => {
      this.sql.exec(`DROP TABLE ${ident(s.name)}`);
      this.sql.exec("DELETE FROM sheet_cols WHERE sheet_id = ?", s.id);
      this.sql.exec("DELETE FROM sheets WHERE id = ?", s.id);
      this.logIt(s.id, null, "delete", { name: s.name, rows: was.rows }, undefined, by);
    });
    return was;
  }

  addColumn(key: string, rawName: unknown, rawType: unknown, by: string): SheetInfo {
    const s = this.need(key);
    const cols = this.cols(s.id);
    if (cols.length >= COLUMNS_MAX) throw new SheetError("too_many", `A worksheet has at most ${COLUMNS_MAX} columns.`);
    const [c] = this.cleanColumns([{ name: rawName, type: rawType ?? "text" }]);
    if (cols.some((x) => x.name.toLowerCase() === c.name.toLowerCase())) throw new SheetError("exists", `There's already a column called "${c.name}".`);
    return this.storage.transactionSync(() => {
      this.sql.exec(`ALTER TABLE ${ident(s.name)} ADD COLUMN ${ident(c.name)} ${SQL_TYPE[c.type]}`);
      this.sql.exec("INSERT INTO sheet_cols (sheet_id, id, name, type, pos) VALUES (?, ?, ?, ?, ?)", s.id, newId("k"), c.name, c.type, cols.length);
      this.touch(s.id, by);
      this.logIt(s.id, null, "add_column", undefined, c, by);
      return this.info(s);
    });
  }

  changeColumn(key: string, colKey: string, change: { name?: unknown; pos?: unknown }, by: string): SheetInfo {
    const s = this.need(key);
    const c = this.column(s.id, colKey);
    return this.storage.transactionSync(() => {
      if (change.name !== undefined) {
        const name = cleanName(change.name, COLUMN_NAME_MAX);
        if (!name || name.startsWith("_")) throw new SheetError("bad_column", `A column name is 1 to ${COLUMN_NAME_MAX} characters, no quotes, not starting with _.`);
        if (name !== c.name) {
          if (this.cols(s.id).some((x) => x.id !== c.id && x.name.toLowerCase() === name.toLowerCase())) throw new SheetError("exists", `There's already a column called "${name}".`);
          this.sql.exec(`ALTER TABLE ${ident(s.name)} RENAME COLUMN ${ident(c.name)} TO ${ident(name)}`);
          this.sql.exec("UPDATE sheet_cols SET name = ? WHERE sheet_id = ? AND id = ?", name, s.id, c.id);
          this.logIt(s.id, null, "rename_column", { name: c.name }, { name }, by);
        }
      }
      if (change.pos !== undefined) {
        const pos = Math.max(0, Math.min(Number(change.pos) || 0, this.cols(s.id).length - 1));
        const order = this.cols(s.id).filter((x) => x.id !== c.id);
        order.splice(pos, 0, { ...c });
        order.forEach((x, i) => this.sql.exec("UPDATE sheet_cols SET pos = ? WHERE sheet_id = ? AND id = ?", i, s.id, x.id));
      }
      this.touch(s.id, by);
      return this.info(s);
    });
  }

  dropColumn(key: string, colKey: string, by: string): SheetInfo {
    const s = this.need(key);
    const c = this.column(s.id, colKey);
    if (this.cols(s.id).length === 1) throw new SheetError("bad_column", "A worksheet keeps at least one column. Delete the worksheet instead.");
    return this.storage.transactionSync(() => {
      this.sql.exec(`ALTER TABLE ${ident(s.name)} DROP COLUMN ${ident(c.name)}`);
      this.sql.exec("DELETE FROM sheet_cols WHERE sheet_id = ? AND id = ?", s.id, c.id);
      this.cols(s.id).forEach((x, i) => this.sql.exec("UPDATE sheet_cols SET pos = ? WHERE sheet_id = ? AND id = ?", i, s.id, x.id));
      this.touch(s.id, by);
      this.logIt(s.id, null, "drop_column", c, undefined, by);
      return this.info(s);
    });
  }

  /** A page of rows, in insertion order or sorted by a column. */
  rows(key: string, opts: { limit?: number; offset?: number; sort?: string; dir?: string } = {}): { sheet: SheetInfo; rows: Row[]; total: number } {
    const s = this.need(key);
    const info = this.info(s);
    const limit = Math.max(1, Math.min(Number(opts.limit) || 500, ROWS_PER_CALL));
    const offset = Math.max(0, Number(opts.offset) || 0);
    let order = "_id";
    if (opts.sort) {
      const c = opts.sort === "_id" || opts.sort === "_at" ? { name: opts.sort } : this.column(s.id, opts.sort);
      order = `${ident(c.name)} ${opts.dir === "desc" ? "DESC" : "ASC"} NULLS LAST, _id`;
    }
    const rows = this.sql.exec<Row>(`SELECT * FROM ${ident(s.name)} ORDER BY ${order} LIMIT ? OFFSET ?`, limit, offset).toArray();
    return { sheet: info, rows, total: info.rows };
  }

  /** Rows by id, for the search index after a change. */
  byIds(key: string, ids: number[]): { sheet: SheetInfo; rows: Row[] } {
    const s = this.need(key);
    const want = ids.filter(Number.isInteger).slice(0, ROWS_PER_CALL);
    const rows = want.length ? this.sql.exec<Row>(`SELECT * FROM ${ident(s.name)} WHERE _id IN (${want.map(() => "?").join(", ")})`, ...want).toArray() : [];
    return { sheet: this.info(s), rows };
  }

  /** Add rows. Each is an object keyed by column name (id works too); unknown keys are refused by name. Returns the new ids. */
  insert(key: string, rawRows: unknown, by: string): { sheet: SheetInfo; ids: number[] } {
    const s = this.need(key);
    const cols = this.cols(s.id);
    if (!Array.isArray(rawRows) || !rawRows.length) throw new SheetError("bad_value", "rows is a list of objects, one per row, keyed by column name.");
    if (rawRows.length > ROWS_PER_CALL) throw new SheetError("too_many", `At most ${ROWS_PER_CALL} rows per call.`);
    if (this.count(s.name) + rawRows.length > ROWS_MAX) throw new SheetError("too_many", `A worksheet holds at most ${ROWS_MAX} rows.`);
    const at = now();
    const ids: number[] = [];
    this.storage.transactionSync(() => {
      for (const raw of rawRows) {
        const cells = this.cells(cols, raw);
        const names = [...cells.keys()];
        const r = this.sql.exec<{ id: number }>(
          `INSERT INTO ${ident(s.name)} (_at, _by${names.map((n) => `, ${ident(n)}`).join("")}) VALUES (?, ?${names.map(() => ", ?").join("")}) RETURNING _id AS id`,
          at, by, ...names.map((n) => cells.get(n) ?? null)).one();
        ids.push(r.id);
        this.logIt(s.id, r.id, "insert", undefined, Object.fromEntries(cells), by);
      }
      this.touch(s.id, by);
    });
    return { sheet: this.info(s), ids };
  }

  /** Change cells on rows that exist. A row id that doesn't is refused, and nothing is written. */
  update(key: string, rawUpdates: unknown, by: string): { sheet: SheetInfo; changed: number } {
    const s = this.need(key);
    const cols = this.cols(s.id);
    if (!Array.isArray(rawUpdates) || !rawUpdates.length) throw new SheetError("bad_value", "updates is a list of {id, cells}, with cells keyed by column name.");
    if (rawUpdates.length > ROWS_PER_CALL) throw new SheetError("too_many", `At most ${ROWS_PER_CALL} rows per call.`);
    const at = now();
    let changed = 0;
    this.storage.transactionSync(() => {
      for (const raw of rawUpdates) {
        const u = (raw ?? {}) as { id?: unknown; cells?: unknown };
        const id = Number(u.id);
        if (!Number.isInteger(id)) throw new SheetError("bad_value", "Each update needs the row's id (the _id read_sheet shows).");
        const before = this.sql.exec<Row>(`SELECT * FROM ${ident(s.name)} WHERE _id = ?`, id).toArray()[0];
        if (!before) throw new SheetError("missing", `There's no row with id ${id}.`);
        const cells = this.cells(cols, u.cells);
        if (!cells.size) continue;
        const names = [...cells.keys()];
        this.sql.exec(`UPDATE ${ident(s.name)} SET _at = ?, _by = ?${names.map((n) => `, ${ident(n)} = ?`).join("")} WHERE _id = ?`, at, by, ...names.map((n) => cells.get(n) ?? null), id);
        const was: Record<string, Cell> = {};
        for (const n of names) was[n] = before[n] ?? null;
        this.logIt(s.id, id, "update", was, Object.fromEntries(cells), by);
        changed += 1;
      }
      this.touch(s.id, by);
    });
    return { sheet: this.info(s), changed };
  }

  deleteRows(key: string, rawIds: unknown, by: string): { sheet: SheetInfo; deleted: number } {
    const s = this.need(key);
    const ids = Array.isArray(rawIds) ? rawIds.map(Number).filter(Number.isInteger) : [];
    if (!ids.length) throw new SheetError("bad_value", "ids is a list of row ids.");
    if (ids.length > ROWS_PER_CALL) throw new SheetError("too_many", `At most ${ROWS_PER_CALL} rows per call.`);
    let deleted = 0;
    this.storage.transactionSync(() => {
      for (const id of ids) {
        const before = this.sql.exec<Row>(`SELECT * FROM ${ident(s.name)} WHERE _id = ?`, id).toArray()[0];
        if (!before) continue;
        this.sql.exec(`DELETE FROM ${ident(s.name)} WHERE _id = ?`, id);
        this.logIt(s.id, id, "delete", before, undefined, by);
        deleted += 1;
      }
      this.touch(s.id, by);
    });
    return { sheet: this.info(s), deleted };
  }

  /**
   * Take back the latest row change on a sheet (insert, update, or delete) from the log: an
   * inserted row is deleted, an updated row gets its old cells, a deleted row comes back with
   * its id. The undo is logged too, naming the entry it undid, so a second undo takes back the
   * change before that one. Column and sheet changes aren't undone here. Null when nothing is left.
   */
  undo(key: string, by: string): { sheet: SheetInfo; undone: { action: string; rowId: number | null } } | null {
    const s = this.need(key);
    type Log = { seq: number; row_id: number | null; action: string; before: string | null; after: string | null };
    const entries = this.sql.exec<Log>("SELECT seq, row_id, action, before, after FROM sheet_log WHERE sheet_id = ? ORDER BY seq DESC LIMIT 200", s.id).toArray();
    const undone = new Set(entries.filter((e) => e.action.startsWith("undo:")).map((e) => Number(e.action.slice(5))));
    const target = entries.find((e) => ["insert", "update", "delete"].includes(e.action) && !undone.has(e.seq));
    if (!target) return null;
    const cols = this.cols(s.id);
    const at = now();
    this.storage.transactionSync(() => {
      const row = (json: string | null) => (json ? (JSON.parse(json) as Record<string, Cell>) : {});
      if (target.action === "insert" && target.row_id !== null) {
        this.sql.exec(`DELETE FROM ${ident(s.name)} WHERE _id = ?`, target.row_id);
      } else if (target.action === "update" && target.row_id !== null) {
        const was = row(target.before);
        const names = Object.keys(was).filter((n) => cols.some((c) => c.name === n));
        if (names.length) this.sql.exec(`UPDATE ${ident(s.name)} SET _at = ?, _by = ?${names.map((n) => `, ${ident(n)} = ?`).join("")} WHERE _id = ?`, at, by, ...names.map((n) => was[n] ?? null), target.row_id);
      } else if (target.action === "delete" && target.row_id !== null) {
        const was = row(target.before);
        const names = cols.map((c) => c.name).filter((n) => n in was);
        this.sql.exec(`INSERT OR REPLACE INTO ${ident(s.name)} (_id, _at, _by${names.map((n) => `, ${ident(n)}`).join("")}) VALUES (?, ?, ?${names.map(() => ", ?").join("")})`, target.row_id, at, by, ...names.map((n) => was[n] ?? null));
      }
      this.logIt(s.id, target.row_id, `undo:${target.seq}`, target.after === null ? undefined : JSON.parse(target.after), target.before === null ? undefined : JSON.parse(target.before), by);
      this.touch(s.id, by);
    });
    return { sheet: this.info(s), undone: { action: target.action, rowId: target.row_id } };
  }

  /** The cells of one row, by column name, each coerced to its type. Keys that aren't columns are refused by name. */
  private cells(cols: Column[], raw: unknown): Map<string, Cell> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SheetError("bad_value", "A row is an object keyed by column name.");
    const out = new Map<string, Cell>();
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (k.startsWith("_")) continue; // _id, _at, _by are the table's
      const c = cols.find((x) => x.id === k || x.name.toLowerCase() === k.toLowerCase());
      if (!c) throw new SheetError("bad_column", `There's no column "${k.slice(0, 40)}". Columns: ${cols.map((x) => x.name).join(", ")}.`);
      out.set(c.name, coerce(c, v));
    }
    return out;
  }

  /**
   * One read-only SELECT over this board's worksheets. Runs inside a transaction that is
   * always rolled back, so even a statement that got past the checks and wrote something
   * changes nothing. At most `limit` rows come back, and the result says when it was cut.
   */
  query(rawSql: unknown, rawLimit?: unknown): QueryResult {
    const sql = typeof rawSql === "string" ? rawSql.trim().replace(/;\s*$/, "") : "";
    if (!sql || sql.length > 20_000) throw new SheetError("bad_query", "sql is one SELECT statement.");
    if (sql.includes(";")) throw new SheetError("bad_query", "One statement at a time: no semicolons.");
    if (!/^(select|with)\b/i.test(sql)) throw new SheetError("bad_query", "Only SELECT (or WITH … SELECT) runs here. Rows are written with write_rows and update_rows.");
    const bare = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
    if (/\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|reindex)\b/i.test(bare)) throw new SheetError("bad_query", "Only SELECT runs here. Rows are written with write_rows and update_rows.");
    if (/\bpragma\b/i.test(bare) && !/\bpragma_/i.test(bare)) throw new SheetError("bad_query", "PRAGMA isn't allowed here.");
    const limit = Math.max(1, Math.min(Number(rawLimit) || QUERY_ROWS_DEFAULT, QUERY_ROWS_MAX));
    let out: QueryResult = { columns: [], rows: [], truncated: false };
    const ROLLBACK = Symbol("rollback");
    try {
      this.storage.transactionSync(() => {
        const cur = this.sql.exec(sql);
        const columns = cur.columnNames;
        const rows: Cell[][] = [];
        let truncated = false;
        for (const r of cur.raw()) {
          if (rows.length >= limit) { truncated = true; break; }
          rows.push(r.map((v) => (v instanceof ArrayBuffer ? `<${v.byteLength} bytes>` : (v as Cell))));
        }
        out = { columns, rows, truncated };
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw new SheetError("bad_query", (e as Error).message.replace(/^.*?: /, "").slice(0, 300));
    }
    return out;
  }
}

// ---------- CSV ----------

/** Parse CSV (RFC 4180: quotes, doubled quotes, newlines in quotes). The first row is headers. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = ""; rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(columns: string[], rows: Cell[][]): string {
  return [columns.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\r\n") + "\r\n";
}

/** A worksheet from CSV text: headers become columns with inferred types; rows follow. */
export function sheetFromCsv(sheets: Sheets, name: unknown, csv: unknown, by: string): { sheet: SheetInfo; rows: number } {
  const grid = typeof csv === "string" ? parseCsv(csv.slice(0, 20 * 1024 * 1024)) : [];
  if (grid.length < 1) throw new SheetError("bad_value", "The CSV needs a header row.");
  const headers = grid[0].map((h, i) => cleanName(h, COLUMN_NAME_MAX) ?? `Column ${i + 1}`).map((h) => (h.startsWith("_") ? h.replace(/^_+/, "") || "Column" : h));
  const seen = new Map<string, number>();
  const names = headers.map((h) => { const n = (seen.get(h.toLowerCase()) ?? 0) + 1; seen.set(h.toLowerCase(), n); return n === 1 ? h : `${h} ${n}`; });
  const body = grid.slice(1, ROWS_MAX + 1);
  const columns = names.map((n, i) => ({ name: n, type: inferType(body.map((r) => r[i])) }));
  const sheet = sheets.create(name, columns, by);
  let total = 0;
  for (let i = 0; i < body.length; i += ROWS_PER_CALL) {
    const batch = body.slice(i, i + ROWS_PER_CALL).map((r) => Object.fromEntries(names.map((n, j) => [n, r[j] ?? ""])));
    total += sheets.insert(sheet.id, batch, by).ids.length;
  }
  return { sheet: sheets.get(sheet.id)!, rows: total };
}

/** A markdown table of rows, for agents. Long cells are cut. */
export function markdownTable(columns: string[], rows: Cell[][], cellMax = 80): string {
  const cell = (v: Cell) => (v === null ? "" : String(v)).replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").slice(0, cellMax);
  return [`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}

// ---------- the HTTP API ----------

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
const fail = (status: number, code: string, error: string) => json({ error, code }, status);
const refused = (e: unknown): Response => {
  const r = sheetRefusal(e);
  if (r) {
    const status = r.code === "missing" ? 404 : r.code === "exists" ? 409 : r.code === "too_many" ? 413 : 400;
    return fail(status, r.code, r.text);
  }
  throw e;
};
/** What a SheetError says, for MCP (mcp.ts): the message, or rethrow anything else. */
export const sheetErrorText = (e: unknown): string => {
  const r = sheetRefusal(e);
  if (r) return r.text;
  throw e;
};

export async function handleSheets(req: Request, env: Env, path: string): Promise<Response | null> {
  if (path !== "/api/sheets" && !path.startsWith("/api/sheets/")) return null;
  const user = await currentUser(req, env);
  if (!user) return json({ error: "signed out" }, 401);
  const url = new URL(req.url);
  const body = req.method === "GET" ? {} : ((await req.json<unknown>().catch(() => null)) as Record<string, unknown> | null) ?? {};
  if (typeof body !== "object" || Array.isArray(body)) return fail(400, "bad_body", "Send a JSON object.");
  const boardKey = url.searchParams.get("board") ?? (typeof body.board === "string" ? body.board : null);
  const w = await fileAccess(env, user, boardKey);
  if (!w) return fail(404, "not_found", "No such board.");
  if (w instanceof Response) return w;
  const docs = env.Docs.get(env.Docs.idFromName(w.board));
  const readOnly = () => fail(403, "read_only", "You can view this board, not change it.");
  const by = w.email;

  try {
    if (path === "/api/sheets") {
      if (req.method === "GET") return json({ sheets: await docs.sheetList() });
      if (req.method === "POST") { if (!w.write) return readOnly(); return json({ sheet: await docs.sheetCreate(body.name, body.columns, by) }, 201); }
      return null;
    }
    if (path === "/api/sheets/import" && req.method === "POST") {
      if (!w.write) return readOnly();
      return json(await docs.sheetImport(body.name, body.csv, by), 201);
    }
    if (path === "/api/sheets/query" && req.method === "POST") {
      return json(await docs.sheetQuery(body.sql, body.limit));
    }
    const parts = path.slice("/api/sheets/".length).split("/");
    const key = decodeURIComponent(parts[0] ?? "");
    const sub = parts.slice(1).join("/");
    if (!key) return null;
    if (sub === "" && req.method === "GET") {
      return json(await docs.sheetRows(key, { limit: Number(url.searchParams.get("limit")), offset: Number(url.searchParams.get("offset")), sort: url.searchParams.get("sort") ?? undefined, dir: url.searchParams.get("dir") ?? undefined }));
    }
    if (sub === "export" && req.method === "GET") {
      const { sheet, rows } = await docs.sheetRows(key, { limit: ROWS_PER_CALL });
      let all = rows;
      for (let off = rows.length; off < sheet.rows; off += ROWS_PER_CALL) all = all.concat((await docs.sheetRows(key, { limit: ROWS_PER_CALL, offset: off })).rows);
      const names = sheet.columns.map((c) => c.name);
      const csv = toCsv(names, all.map((r) => names.map((n) => r[n] ?? null)));
      return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${sheet.name.replace(/[^\w.-]+/g, "_")}.csv"`, "Cache-Control": "no-store" } });
    }
    if (!w.write) return readOnly();
    if (sub === "" && req.method === "DELETE") return json({ sheet: await docs.sheetRemove(key, by), deleted: true });
    if (sub === "rename" && req.method === "POST") return json({ sheet: await docs.sheetRename(key, body.name, by) });
    if (sub === "undo" && req.method === "POST") {
      const r = await docs.sheetUndo(key, by);
      return r ? json(r) : fail(404, "nothing", "Nothing to undo on this worksheet.");
    }
    if (sub === "rows") {
      if (req.method === "POST") return json(await docs.sheetInsert(key, body.rows, by), 201);
      if (req.method === "PATCH") return json(await docs.sheetUpdate(key, body.updates, by));
      if (req.method === "DELETE") return json(await docs.sheetDeleteRows(key, body.ids, by));
    }
    if (sub === "columns" && req.method === "POST") return json({ sheet: await docs.sheetAddColumn(key, body.name, body.type, by) }, 201);
    if (sub.startsWith("columns/")) {
      const col = decodeURIComponent(sub.slice("columns/".length));
      if (req.method === "PATCH") return json({ sheet: await docs.sheetChangeColumn(key, col, { name: body.name, pos: body.pos }, by) });
      if (req.method === "DELETE") return json({ sheet: await docs.sheetDropColumn(key, col, by) });
    }
    return null;
  } catch (e) {
    return refused(e);
  }
}
