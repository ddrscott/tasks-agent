// A board's worksheets (// WORKSHEETS in the README): the list on the left, the grid on the
// right. A worksheet is a typed table in the board's Docs object; cells are edited in place
// and saved one at a time, rows are added at the bottom, columns from the header. The query
// box runs one read-only SELECT over the board's worksheets, the same thing agents do with
// query_sheet. Everything here is the REST API in src/sheets.ts.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { COLUMN_TYPES, type Cell, type Column, type ColumnType, type QueryResult, type Row, type SheetInfo } from "../sheets-shared";
import { api, BASE } from "./base";
import { Footer } from "./Footer";
import { boardName, type Boards } from "./member";
import { useTitle } from "./title";

type Props = {
  me: { id: string; email: string };
  board: string | null;
  boards: Boards | null;
  onBoard(): void;
};

const q = (board: string | null, more = "") => `?board=${encodeURIComponent(board ?? "")}${more}`;
const sheetUrl = (board: string | null, sheet: string | null) => {
  const p = new URLSearchParams();
  if (board) p.set("board", board);
  if (sheet) p.set("sheet", sheet);
  return `${BASE}/sheets${p.size ? `?${p}` : ""}`;
};
const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(); };
const PAGE = 500;

/** A cell as shown in the grid when it isn't being edited. */
function show(c: Column, v: Cell): string {
  if (v === null || v === undefined) return "";
  if (c.type === "number") return typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toLocaleString(undefined, { maximumFractionDigits: 4 })) : String(v);
  return String(v);
}

export function Sheets({ me, board, boards, onBoard }: Props) {
  useTitle("Worksheets");
  const id = board ?? me.id;
  const [sheets, setSheets] = useState<SheetInfo[] | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.search).get("sheet"));
  /** A row to point at once the sheet is up: a search hit (// SEARCH). */
  const [pointed, setPointed] = useState<number | null>(() => { const r = Number(new URLSearchParams(location.search).get("row")); return Number.isInteger(r) && r > 0 ? r : null; });
  const [sheet, setSheet] = useState<SheetInfo | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [sort, setSort] = useState<{ col: string; desc: boolean } | null>(null);
  const [filter, setFilter] = useState("");
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [armedDelete, setArmedDelete] = useState(false);
  const [addingCol, setAddingCol] = useState<{ name: string; type: ColumnType } | null>(null);
  const [colMenu, setColMenu] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ row: number; col: string; value: string } | null>(null);
  const [draftRow, setDraftRow] = useState<Record<string, string>>({});
  const [querying, setQuerying] = useState(false);
  const [sql, setSql] = useState("");
  const [result, setResult] = useState<QueryResult | { error: string } | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const editInput = useRef<HTMLInputElement>(null);

  const say = useCallback((kind: "ok" | "error", text: string) => setNote({ kind, text }), []);
  const call = useCallback(async (method: string, path: string, body?: unknown) => {
    const r = await fetch(api(path), { method, headers: body === undefined ? {} : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify({ board: id, ...(body as object) }) });
    const data = (await r.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: r.ok, status: r.status, data };
  }, [id]);

  const loadList = useCallback(async () => {
    const r = await call("GET", `/api/sheets${q(id)}`);
    if (!r.ok) { setSheets([]); say("error", r.status === 404 ? "That board isn't yours to read." : "The list didn't load. Try again in a minute."); return; }
    setSheets((r.data as { sheets: SheetInfo[] }).sheets);
  }, [id, call, say]);

  useEffect(() => {
    void loadList();
    fetch(api(`/api/board/access${q(id)}`)).then(async (r) => {
      const a = r.ok ? ((await r.json()) as { access?: { effective?: string } }).access : null;
      setCanWrite(a?.effective === "owner" || a?.effective === "writer");
    }).catch(() => setCanWrite(false));
  }, [id, loadList]);

  const loadRows = useCallback(async (key: string, s: { col: string; desc: boolean } | null) => {
    const r = await call("GET", `/api/sheets/${encodeURIComponent(key)}${q(id, `&limit=${PAGE}${s ? `&sort=${encodeURIComponent(s.col)}&dir=${s.desc ? "desc" : "asc"}` : ""}`)}`);
    if (!r.ok) { setSheet(null); say("error", r.status === 404 ? "There's no worksheet by that name anymore." : "That worksheet didn't load."); return; }
    const d = r.data as { sheet: SheetInfo; rows: Row[]; total: number };
    setSheet(d.sheet);
    setRows(d.rows);
    setTotal(d.total);
  }, [id, call, say]);

  const open = useCallback(async (key: string | null) => {
    setSelected(key);
    setSheet(null);
    setRows([]);
    setSort(null);
    setFilter("");
    setNote(null);
    setEditing(null);
    setDraftRow({});
    setRenaming(null);
    setArmedDelete(false);
    setAddingCol(null);
    setResult(null);
    history.replaceState(null, "", sheetUrl(board, key));
    if (key) await loadRows(key, null);
  }, [board, loadRows]);

  const openedOnce = useRef(false);
  useEffect(() => {
    if (sheets && selected && !openedOnce.current) { openedOnce.current = true; void open(selected); }
  }, [sheets, selected, open]);

  // Someone else (or their agent) changing the open worksheet: every few seconds compare its
  // last change with what's on screen, and reload the rows when nothing here is mid-edit.
  const liveRef = useRef({ sheet, sort, editing, draftRow });
  liveRef.current = { sheet, sort, editing, draftRow };
  useEffect(() => {
    let off = false;
    const tick = async () => {
      if (off || document.hidden) return;
      try {
        const r = await fetch(api(`/api/sheets${q(id)}`));
        if (!r.ok || off) return;
        const list = ((await r.json()) as { sheets: SheetInfo[] }).sheets;
        setSheets(list);
        const { sheet: s, sort: so, editing: ed, draftRow: dr } = liveRef.current;
        if (!s) return;
        const now = list.find((x) => x.id === s.id);
        if (!now) { say("error", "This worksheet was deleted."); setSheet(null); return; }
        if (now.updatedAt === s.updatedAt) return;
        if (ed || Object.values(dr).some((v) => v !== "")) { setSheet({ ...s, updatedAt: now.updatedAt, updatedBy: now.updatedBy }); say("ok", `${now.updatedBy === me.email ? "You, elsewhere," : now.updatedBy} changed this worksheet. It reloads when you finish the cell.`); return; }
        await loadRows(s.id, so);
      } catch { /* the next tick will try again */ }
    };
    const t = setInterval(() => { void tick(); }, 5000);
    return () => { off = true; clearInterval(t); };
  }, [id, me.email, loadRows, say]);

  const refresh = useCallback(async () => {
    if (sheet) await loadRows(sheet.id, sort);
    void loadList();
  }, [sheet, sort, loadRows, loadList]);

  const create = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    const r = await call("POST", "/api/sheets", { name, columns: [{ name: "Name", type: "text" }, { name: "Amount", type: "number" }, { name: "Date", type: "date" }, { name: "Done", type: "checkbox" }] });
    if (!r.ok) { say("error", String(r.data?.error ?? "That didn't work.")); return; }
    setNewName("");
    await loadList();
    void open((r.data as { sheet: SheetInfo }).sheet.id);
  }, [newName, call, say, loadList, open]);

  const importCsv = useCallback(async (list: FileList | null) => {
    const f = list?.[0];
    if (!f) return;
    const csv = await f.text();
    const name = f.name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim() || "Imported";
    const r = await call("POST", "/api/sheets/import", { name, csv });
    if (!r.ok) { say("error", String(r.data?.error ?? "The import didn't work.")); return; }
    const d = r.data as { sheet: SheetInfo; rows: number };
    await loadList();
    await open(d.sheet.id);
    say("ok", `Imported ${d.rows} rows into ${d.sheet.name}.`);
  }, [call, say, loadList, open]);

  const rename = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sheet || renaming === null) return;
    const to = renaming.trim();
    if (!to || to === sheet.name) { setRenaming(null); return; }
    const r = await call("POST", `/api/sheets/${encodeURIComponent(sheet.id)}/rename`, { name: to });
    if (!r.ok) { say("error", String(r.data?.error ?? "The rename didn't go through.")); return; }
    setRenaming(null);
    await refresh();
  }, [sheet, renaming, call, say, refresh]);

  const undo = useCallback(async () => {
    if (!sheet) return;
    const r = await call("POST", `/api/sheets/${encodeURIComponent(sheet.id)}/undo`, {});
    if (!r.ok) { say("error", String(r.data?.error ?? "Nothing to undo.")); return; }
    const u = (r.data as { undone: { action: string; rowId: number | null } }).undone;
    say("ok", u.action === "insert" ? `Took back the added row.` : u.action === "delete" ? `Brought row ${u.rowId} back.` : `Put row ${u.rowId} back as it was.`);
    await refresh();
  }, [sheet, call, say, refresh]);

  const remove = useCallback(async () => {
    if (!sheet) return;
    const r = await call("DELETE", `/api/sheets/${encodeURIComponent(sheet.id)}${q(id)}`);
    if (!r.ok) { say("error", "The delete didn't go through."); return; }
    await loadList();
    void open(null);
    say("ok", `Deleted ${sheet.name}.`);
  }, [sheet, id, call, say, loadList, open]);

  const addColumn = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sheet || !addingCol?.name.trim()) return;
    const r = await call("POST", `/api/sheets/${encodeURIComponent(sheet.id)}/columns`, { name: addingCol.name.trim(), type: addingCol.type });
    if (!r.ok) { say("error", String(r.data?.error ?? "That didn't work.")); return; }
    setAddingCol(null);
    await refresh();
  }, [sheet, addingCol, call, say, refresh]);

  const renameColumn = useCallback(async (col: Column) => {
    const name = prompt(`Rename column "${col.name}" to:`, col.name)?.trim();
    setColMenu(null);
    if (!sheet || !name || name === col.name) return;
    const r = await call("PATCH", `/api/sheets/${encodeURIComponent(sheet.id)}/columns/${encodeURIComponent(col.id)}`, { name });
    if (!r.ok) { say("error", String(r.data?.error ?? "That didn't work.")); return; }
    await refresh();
  }, [sheet, call, say, refresh]);

  const dropColumn = useCallback(async (col: Column) => {
    setColMenu(null);
    if (!sheet) return;
    const r = await call("DELETE", `/api/sheets/${encodeURIComponent(sheet.id)}/columns/${encodeURIComponent(col.id)}${q(id)}`);
    if (!r.ok) { say("error", String(r.data?.error ?? "That didn't work.")); return; }
    await refresh();
  }, [sheet, id, call, say, refresh]);

  const moveColumn = useCallback(async (col: Column, by: number) => {
    setColMenu(null);
    if (!sheet) return;
    const r = await call("PATCH", `/api/sheets/${encodeURIComponent(sheet.id)}/columns/${encodeURIComponent(col.id)}`, { pos: col.pos + by });
    if (!r.ok) { say("error", String(r.data?.error ?? "That didn't work.")); return; }
    await refresh();
  }, [sheet, call, say, refresh]);

  /** Save one cell. The grid updates in place; the server's answer (or refusal) comes after. */
  const saveCell = useCallback(async (rowId: number, col: Column, raw: string | boolean) => {
    if (!sheet) return;
    const r = await call("PATCH", `/api/sheets/${encodeURIComponent(sheet.id)}/rows`, { updates: [{ id: rowId, cells: { [col.name]: raw } }] });
    if (!r.ok) { say("error", String(r.data?.error ?? "That didn't save.")); await loadRows(sheet.id, sort); return; }
    setNote(null);
    await loadRows(sheet.id, sort);
  }, [sheet, sort, call, say, loadRows]);

  const addRow = useCallback(async () => {
    if (!sheet) return;
    const cells = Object.fromEntries(Object.entries(draftRow).filter(([, v]) => v !== ""));
    if (!Object.keys(cells).length) return;
    const r = await call("POST", `/api/sheets/${encodeURIComponent(sheet.id)}/rows`, { rows: [cells] });
    if (!r.ok) { say("error", String(r.data?.error ?? "That row didn't save.")); return; }
    setDraftRow({});
    setNote(null);
    await refresh();
  }, [sheet, draftRow, call, say, refresh]);

  const deleteRow = useCallback(async (rowId: number) => {
    if (!sheet) return;
    const r = await call("DELETE", `/api/sheets/${encodeURIComponent(sheet.id)}/rows`, { ids: [rowId] });
    if (!r.ok) { say("error", "That row didn't delete."); return; }
    await refresh();
  }, [sheet, call, say, refresh]);

  const runQuery = useCallback(async () => {
    const s = sql.trim();
    if (!s) return;
    const r = await call("POST", "/api/sheets/query", { sql: s, limit: 500 });
    if (!r.ok) { setResult({ error: String(r.data?.error ?? "The query didn't run.") }); return; }
    setResult(r.data as unknown as QueryResult);
  }, [sql, call]);

  useEffect(() => { if (editing) editInput.current?.focus(); }, [editing]);

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f || !sheet) return rows;
    return rows.filter((r) => sheet.columns.some((c) => show(c, r[c.name] ?? null).toLowerCase().includes(f)));
  }, [rows, filter, sheet]);

  const name = boardName(boards, board, me.id);
  const toggleSort = (col: Column) => {
    const next = sort?.col === col.name ? (sort.desc ? null : { col: col.name, desc: true }) : { col: col.name, desc: false };
    setSort(next);
    if (sheet) void loadRows(sheet.id, next);
  };

  const cellEditor = (r: Row, c: Column) => {
    const v = r[c.name] ?? null;
    if (c.type === "checkbox") {
      return <input type="checkbox" checked={v === 1} disabled={!canWrite} onChange={(e) => void saveCell(r._id, c, e.target.checked)} aria-label={c.name} />;
    }
    const isEditing = editing && editing.row === r._id && editing.col === c.id;
    if (isEditing) {
      return (
        <input
          ref={editInput} className="sheet-input" type={c.type === "date" ? "date" : c.type === "number" ? "text" : "text"} value={editing.value}
          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
          onBlur={() => { const val = editing.value; setEditing(null); if (val !== show(c, v)) void saveCell(r._id, c, val); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); (e.currentTarget as HTMLInputElement).blur(); }
            if (e.key === "Escape") { setEditing(null); }
          }}
          aria-label={c.name}
        />
      );
    }
    const text = show(c, v);
    return (
      <button className={`sheet-cell-btn${c.type === "number" ? " num" : ""}`} disabled={!canWrite} onClick={() => setEditing({ row: r._id, col: c.id, value: v === null ? "" : String(v) })} title={canWrite ? "Click to edit" : undefined}>
        {c.type === "link" && text ? <a href={/^https?:\/\//.test(text) ? text : undefined} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{text}</a> : text || <span className="sheet-empty">·</span>}
      </button>
    );
  };

  return (
    <div className="app">
      <div className="main">
        <header className="topbar pages-bar">
          <h1 className="wordmark">tasks<span>.</span></h1>
          <button className="btn" onClick={onBoard} title="Back to the board">← {name}</button>
          <span className="pages-crumb">worksheets</span>
          <span className="spacer" />
          {canWrite && <button className="btn" onClick={() => upload.current?.click()}>Import CSV</button>}
          <input ref={upload} type="file" accept=".csv,text/csv" hidden onChange={(e) => { void importCsv(e.target.files); e.target.value = ""; }} />
        </header>

        <div className="pages sheets">
          <aside className="pages-list" aria-label="Worksheets">
            {canWrite && (
              <form className="pages-new" onSubmit={(e) => void create(e)}>
                <input className="field" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Sales 2026" aria-label="New worksheet name" />
                <button className="btn primary" type="submit" disabled={!newName.trim()}>New</button>
              </form>
            )}
            {sheets === null && <p className="pages-empty">loading</p>}
            {sheets?.length === 0 && <p className="pages-empty">No worksheets yet.{canWrite ? " Make one above, import a CSV, or have your agent call create_sheet." : ""}</p>}
            {sheets?.map((s) => (
              <button key={s.id} className={`pages-item${selected === s.id || selected === s.name ? " active" : ""}`} onClick={() => void open(s.id)} title={`${s.rows} rows · ${s.updatedBy}, ${when(s.updatedAt)}`}>
                {(selected === s.id || selected === s.name) && <span className="pages-mark" aria-hidden="true">$</span>}
                <span className="pages-item-name">{s.name}</span>
                <span className="sheet-count">{s.rows}</span>
              </button>
            ))}
            <div className="sheet-query-toggle">
              <button className={`btn${querying ? " primary" : ""}`} onClick={() => setQuerying(!querying)} aria-pressed={querying}>SQL</button>
            </div>
          </aside>

          <section className="pages-main">
            {querying && (
              <div className="sheet-query">
                <div className="menu-label h">QUERY</div>
                <textarea className="field sheet-sql" value={sql} onChange={(e) => setSql(e.target.value)} spellCheck={false} placeholder={`SELECT * FROM "${sheet?.name ?? "Sales 2026"}" LIMIT 20`}
                  onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void runQuery(); }} aria-label="SQL query" />
                <div className="sheet-query-row">
                  <button className="btn primary" onClick={() => void runQuery()} disabled={!sql.trim()}>Run</button>
                  <span className="pages-meta">One SELECT over this board's worksheets. ⌘Enter runs it. Agents do the same with query_sheet.</span>
                </div>
                {result && "error" in result && <p className="pages-note error" role="status">{result.error}</p>}
                {result && "rows" in result && (
                  <div className="sheet-scroll">
                    <table className="sheet-table sheet-result">
                      <thead><tr>{result.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
                      <tbody>{result.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={typeof v === "number" ? "num" : ""}>{v === null ? "" : typeof v === "number" ? show({ id: "", name: "", type: "number", pos: 0 }, v) : String(v)}</td>)}</tr>)}</tbody>
                    </table>
                    <p className="pages-meta">{result.rows.length} {result.rows.length === 1 ? "row" : "rows"}{result.truncated ? " (cut; add a LIMIT or a WHERE)" : ""}</p>
                  </div>
                )}
              </div>
            )}
            {!sheet && !querying && <div className="pages-empty pages-welcome">
              <h2 className="h">WORKSHEETS</h2>
              <p>A worksheet is a table with typed columns: text, number, date, checkbox, link. Edit cells in place; your agents read, write, and query it with SQL over MCP (list_sheets, read_sheet, write_rows, query_sheet). Pick one on the left{canWrite ? ", make one, or import a CSV" : ""}.</p>
            </div>}
            {sheet && (
              <>
                <div className="pages-head">
                  {renaming !== null
                    ? <form className="pages-rename" onSubmit={(e) => void rename(e)}><input className="field" value={renaming} onChange={(e) => setRenaming(e.target.value)} autoFocus aria-label="New name" /><button className="btn primary" type="submit">Rename</button><button className="btn ghost" type="button" onClick={() => setRenaming(null)}>Cancel</button></form>
                    : <h2 className="pages-title">{sheet.name}</h2>}
                  <span className="pages-meta">{total} {total === 1 ? "row" : "rows"} · changed by {sheet.updatedBy === me.email ? "you" : sheet.updatedBy}, {when(sheet.updatedAt)}</span>
                  <span className="spacer" />
                  <input className="field sheet-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter rows" aria-label="Filter rows" />
                  {canWrite && <button className="btn" onClick={() => void undo()} title="Take back the last row change on this worksheet">Undo</button>}
                  {canWrite && renaming === null && <button className="btn" onClick={() => setRenaming(sheet.name)}>Rename</button>}
                  <a className="btn" href={api(`/api/sheets/${encodeURIComponent(sheet.id)}/export${q(id)}`)} download>Export CSV</a>
                  {canWrite && (
                    <button className={`btn danger${armedDelete ? " armed" : ""}`} onClick={() => { if (!armedDelete) { setArmedDelete(true); return; } void remove(); }} onBlur={() => setArmedDelete(false)}>
                      {armedDelete ? "Tap again to delete" : "Delete"}
                    </button>
                  )}
                </div>
                {note && <p className={`pages-note ${note.kind}`} role="status">{note.text}</p>}
                <div className="sheet-scroll">
                  <table className="sheet-table">
                    <thead>
                      <tr>
                        <th className="sheet-rownum">#</th>
                        {sheet.columns.map((c) => (
                          <th key={c.id} className={c.type === "number" ? "num" : ""}>
                            <div className="sheet-th">
                              <button className="sheet-sort" onClick={() => toggleSort(c)} title={`Sort by ${c.name}`}>
                                {c.name}{sort?.col === c.name ? (sort.desc ? " ↓" : " ↑") : ""}
                              </button>
                              <span className="sheet-type">{c.type}</span>
                              {canWrite && <button className="sheet-colmenu" onClick={() => setColMenu(colMenu === c.id ? null : c.id)} aria-label={`${c.name} column menu`} aria-expanded={colMenu === c.id}>⋯</button>}
                            </div>
                            {colMenu === c.id && (
                              <div className="popover sheet-colpop" role="menu">
                                <button role="menuitem" onClick={() => void renameColumn(c)}>Rename</button>
                                <button role="menuitem" onClick={() => void moveColumn(c, -1)} disabled={c.pos === 0}>Move left</button>
                                <button role="menuitem" onClick={() => void moveColumn(c, 1)} disabled={c.pos === sheet.columns.length - 1}>Move right</button>
                                <button role="menuitem" className="danger" onClick={() => void dropColumn(c)} disabled={sheet.columns.length === 1}>Delete column</button>
                              </div>
                            )}
                          </th>
                        ))}
                        {canWrite && (
                          <th className="sheet-addcol">
                            {addingCol ? (
                              <form className="sheet-addcol-form" onSubmit={(e) => void addColumn(e)}>
                                <input className="field" value={addingCol.name} onChange={(e) => setAddingCol({ ...addingCol, name: e.target.value })} placeholder="Column" autoFocus aria-label="New column name" />
                                <select className="field" value={addingCol.type} onChange={(e) => setAddingCol({ ...addingCol, type: e.target.value as ColumnType })} aria-label="Column type">
                                  {COLUMN_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                                </select>
                                <button className="btn primary" type="submit" disabled={!addingCol.name.trim()}>Add</button>
                                <button className="btn ghost" type="button" onClick={() => setAddingCol(null)}>Cancel</button>
                              </form>
                            ) : <button className="btn" onClick={() => setAddingCol({ name: "", type: "text" })} title="Add a column">+ column</button>}
                          </th>
                        )}
                        {canWrite && <th className="sheet-rowdel" />}
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((r, i) => (
                        <tr key={r._id} className={pointed === r._id ? "sheet-pointed" : undefined} ref={pointed === r._id ? (el) => { el?.scrollIntoView({ block: "center" }); } : undefined} title={`row ${r._id} · ${r._by}, ${when(r._at)}`} onClick={() => { if (pointed) setPointed(null); }}>
                          <td className="sheet-rownum">{i + 1}</td>
                          {sheet.columns.map((c) => <td key={c.id} className={c.type === "number" ? "num" : c.type === "checkbox" ? "check" : ""}>{cellEditor(r, c)}</td>)}
                          {canWrite && <td />}
                          {canWrite && <td className="sheet-rowdel"><button className="sheet-x" onClick={() => void deleteRow(r._id)} aria-label={`Delete row ${i + 1}`} title="Delete row">×</button></td>}
                        </tr>
                      ))}
                      {canWrite && !filter && (
                        <tr className="sheet-new">
                          <td className="sheet-rownum">+</td>
                          {sheet.columns.map((c) => (
                            <td key={c.id} className={c.type === "number" ? "num" : c.type === "checkbox" ? "check" : ""}>
                              {c.type === "checkbox"
                                ? <input type="checkbox" checked={draftRow[c.name] === "true"} onChange={(e) => setDraftRow({ ...draftRow, [c.name]: e.target.checked ? "true" : "" })} aria-label={`New row ${c.name}`} />
                                : <input className="sheet-input" type={c.type === "date" ? "date" : "text"} value={draftRow[c.name] ?? ""} placeholder={c.name} aria-label={`New row ${c.name}`}
                                    onChange={(e) => setDraftRow({ ...draftRow, [c.name]: e.target.value })}
                                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addRow(); } }} />}
                            </td>
                          ))}
                          <td /><td className="sheet-rowdel"><button className="btn primary sheet-addrow" onClick={() => void addRow()} disabled={!Object.values(draftRow).some((v) => v !== "")}>Add</button></td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  {shown.length === 0 && rows.length > 0 && <p className="pages-empty">No rows match “{filter}”.</p>}
                  {total > rows.length && <p className="pages-meta">Showing the first {rows.length} of {total} rows. Sort to see others, or query with SQL.</p>}
                </div>
              </>
            )}
            {!sheet && note && <p className={`pages-note ${note.kind}`} role="status">{note.text}</p>}
          </section>
        </div>
        <Footer />
      </div>
    </div>
  );
}
