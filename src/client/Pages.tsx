// A board's pages and files (// PAGES in the README): the list on the left, the page on the
// right. A page is Markdown (or other text) rendered with the same renderer card notes use,
// edited in a plain textarea, and saved with the etag it was opened at, so a change someone
// else (or their agent) made in between is caught and said, never overwritten. Files that
// aren't text show as a link, or inline when they're images. Everything here is the REST API
// in src/docs.ts; agents use the same store over MCP.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileInfo, Revision } from "../docs";
import { api, BASE } from "./base";
import { Footer } from "./Footer";
import { Markdown } from "./Markdown";
import { boardName, type Boards } from "./member";
import { useTitle } from "./title";

type Props = {
  me: { id: string; email: string };
  /** The board, or null for your first. */
  board: string | null;
  boards: Boards | null;
  /** Back to the board itself. */
  onBoard(): void;
};

type Loaded = { info: FileInfo; text: string | null };
const IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]);
const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(); };
const q = (board: string | null, more = "") => `?board=${encodeURIComponent(board ?? "")}${more}`;

/** A page's URL on this screen, so a reload or a link comes back to it. */
const pathUrl = (board: string | null, path: string | null) =>
  `${BASE}/pages${board ? `?board=${board}` : ""}${path ? `${board ? "&" : "?"}path=${encodeURIComponent(path)}` : ""}`;

export function Pages({ me, board, boards, onBoard }: Props) {
  useTitle("Pages");
  const id = board ?? me.id;
  const [files, setFiles] = useState<FileInfo[] | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.search).get("path"));
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "error"; text: string; reload?: boolean } | null>(null);
  const [newPath, setNewPath] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [armedDelete, setArmedDelete] = useState(false);
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [viewingRev, setViewingRev] = useState<{ etag: string; text: string; at: string; by: string } | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const upload = useRef<HTMLInputElement>(null);

  const say = useCallback((kind: "ok" | "error", text: string, reload = false) => setNote({ kind, text, reload }), []);

  const loadList = useCallback(async () => {
    const r = await fetch(api(`/api/files${q(id)}`));
    if (!r.ok) { setFiles([]); say("error", r.status === 404 ? "That board isn't yours to read." : "The list didn't load. Try again in a minute."); return; }
    setFiles(((await r.json()) as { files: FileInfo[] }).files);
  }, [id, say]);

  useEffect(() => {
    void loadList();
    fetch(api(`/api/board/access${q(id)}`)).then(async (r) => {
      const a = r.ok ? ((await r.json()) as { access?: { effective?: string } }).access : null;
      setCanWrite(a?.effective === "owner" || a?.effective === "writer");
    }).catch(() => setCanWrite(false));
  }, [id, loadList]);

  const open = useCallback(async (path: string | null, edit = false) => {
    setSelected(path);
    setEditing(false);
    setViewingRev(null);
    setRevisions(null);
    setArmedDelete(false);
    setNote(null);
    history.replaceState(null, "", pathUrl(board, path));
    if (!path) { setLoaded(null); return; }
    const r = await fetch(api(`/api/files/${path.split("/").map(encodeURIComponent).join("/")}${q(id)}`), { headers: { Accept: "application/json" } });
    if (!r.ok) { setLoaded(null); say("error", r.status === 404 ? "There's no page at that path anymore." : "That page didn't load."); return; }
    const type = r.headers.get("Content-Type") ?? "";
    if (type.includes("application/json")) {
      const data = (await r.json()) as { file: FileInfo; text: string };
      setLoaded({ info: data.file, text: data.text });
      if (edit) { setDraft(data.text); setEditing(true); }
    } else {
      // A file that isn't a page: the list has its info; the bytes are a link.
      const info = files?.find((f) => f.path === path) ?? null;
      setLoaded(info ? { info, text: null } : null);
    }
  }, [board, id, files, say]);

  // The page named in the address, once the list is in.
  const openedOnce = useRef(false);
  useEffect(() => {
    if (files && selected && !openedOnce.current) { openedOnce.current = true; void open(selected); }
  }, [files, selected, open]);

  const put = useCallback(async (path: string, body: string | Uint8Array, headers: Record<string, string>) => {
    const r = await fetch(api(`/api/files/${path.split("/").map(encodeURIComponent).join("/")}${q(id)}`), { method: "PUT", body: body as BodyInit, headers });
    const data = (await r.json().catch(() => null)) as { file?: FileInfo; error?: string; code?: string } | null;
    return { status: r.status, data };
  }, [id]);

  const save = useCallback(async () => {
    if (!loaded || busy) return;
    setBusy(true);
    const bytes = new TextEncoder().encode(draft);
    const r = await put(loaded.info.path, bytes, { "Content-Type": loaded.info.type, "Content-Length": String(bytes.length), "If-Match": loaded.info.etag });
    setBusy(false);
    if (r.status === 412) { say("error", "Someone changed this page since you opened it. Copy what you typed, then reload to see the newest version.", true); return; }
    if (!r.data?.file) { say("error", r.data?.error ?? "The save didn't go through."); return; }
    setLoaded({ info: r.data.file, text: draft });
    setEditing(false);
    say("ok", "Saved.");
    void loadList();
  }, [loaded, busy, draft, put, say, loadList]);

  const create = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    let path = newPath.trim().replace(/^\/+|\/+$/g, "");
    if (!path) return;
    if (!/\.[a-z0-9]+$/i.test(path)) path += ".md";
    const title = path.split("/").pop()!.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ");
    const body = path.endsWith(".md") ? `# ${title}\n\n` : "";
    const bytes = new TextEncoder().encode(body);
    const r = await put(path, bytes, { "Content-Type": path.endsWith(".md") ? "text/markdown" : "text/plain", "Content-Length": String(bytes.length), "If-None-Match": "*" });
    if (!r.data?.file) { say("error", r.status === 412 ? "There's already a page at that path." : r.data?.error ?? "That didn't work."); return; }
    setNewPath("");
    await loadList();
    void open(path, true);
  }, [newPath, put, say, loadList, open]);

  const uploadFiles = useCallback(async (list: FileList | null) => {
    if (!list?.length) return;
    const folder = selected && selected.includes("/") ? selected.slice(0, selected.lastIndexOf("/")) : "files";
    let last: string | null = null;
    for (const f of Array.from(list)) {
      const name = f.name.replace(/[\\/]/g, "_");
      const bytes = new Uint8Array(await f.arrayBuffer());
      const r = await put(`${folder}/${name}`, bytes, { "Content-Type": f.type || "application/octet-stream", "Content-Length": String(bytes.length) });
      if (!r.data?.file) { say("error", r.data?.error ?? `${name} didn't upload.`); break; }
      last = r.data.file.path;
    }
    await loadList();
    if (last) void open(last);
  }, [selected, put, say, loadList, open]);

  const remove = useCallback(async () => {
    if (!loaded) return;
    const r = await fetch(api(`/api/files/${loaded.info.path.split("/").map(encodeURIComponent).join("/")}${q(id)}`), { method: "DELETE" });
    if (!r.ok) { say("error", "The delete didn't go through."); return; }
    say("ok", `Deleted ${loaded.info.path}.`);
    await loadList();
    void open(null);
  }, [loaded, id, say, loadList, open]);

  const rename = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loaded || renaming === null) return;
    const to = renaming.trim().replace(/^\/+|\/+$/g, "");
    if (!to || to === loaded.info.path) { setRenaming(null); return; }
    const r = await fetch(api("/api/files/move"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ board: id, from: loaded.info.path, to }) });
    const data = (await r.json().catch(() => null)) as { file?: FileInfo; error?: string } | null;
    if (!data?.file) { say("error", data?.error ?? "The rename didn't go through."); return; }
    setRenaming(null);
    await loadList();
    void open(data.file.path);
  }, [loaded, renaming, id, say, loadList, open]);

  const showRevisions = useCallback(async () => {
    if (!loaded) return;
    const r = await fetch(api(`/api/files/${loaded.info.path.split("/").map(encodeURIComponent).join("/")}/revisions${q(id)}`));
    const data = (await r.json().catch(() => null)) as { revisions?: Revision[] } | null;
    setRevisions(data?.revisions ?? []);
  }, [loaded, id]);

  const viewRevision = useCallback(async (etag: string) => {
    if (!loaded) return;
    const r = await fetch(api(`/api/files/${loaded.info.path.split("/").map(encodeURIComponent).join("/")}/revisions${q(id, `&rev=${etag}`)}`));
    const data = (await r.json().catch(() => null)) as { text?: string; at?: string; by?: string } | null;
    if (data?.text !== undefined) setViewingRev({ etag, text: data.text, at: data.at ?? "", by: data.by ?? "" });
  }, [loaded, id]);

  const restore = useCallback(async () => {
    if (!loaded || !viewingRev) return;
    setDraft(viewingRev.text);
    setViewingRev(null);
    setEditing(true);
    say("ok", "That version is in the editor. Save to make it the page again.");
  }, [loaded, viewingRev, say]);

  // The list, grouped by folder, folders first then files, both alphabetical.
  const tree = useMemo(() => {
    const groups = new Map<string, FileInfo[]>();
    for (const f of files ?? []) {
      const folder = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
      groups.set(folder, [...(groups.get(folder) ?? []), f]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([folder, list]) => [folder, list.sort((a, b) => a.path.localeCompare(b.path))] as const);
  }, [files]);

  const name = boardName(boards, board, me.id);
  const text = viewingRev ? viewingRev.text : loaded?.text ?? null;
  const isMd = loaded?.info.type === "text/markdown";

  return (
    <div className="app">
      <div className="main">
        <header className="topbar">
          <h1 className="wordmark">tasks<span>.</span></h1>
          <button className="btn" onClick={onBoard} title="Back to the board">← {name}</button>
          <span className="pages-crumb">pages</span>
          <span className="spacer" />
          {files && files.some((f) => f.page) && <a className="btn" href={api(`/api/files${q(id, "&format=zip")}`)} download title="Every page, as written, in one zip">Download all</a>}
          {canWrite && <button className="btn" onClick={() => upload.current?.click()}>Upload files</button>}
          <input ref={upload} type="file" multiple hidden onChange={(e) => { void uploadFiles(e.target.files); e.target.value = ""; }} />
        </header>

        <div className="pages">
          <aside className="pages-list" aria-label="Pages and files">
            {canWrite && (
              <form className="pages-new" onSubmit={(e) => void create(e)}>
                <input className="field" value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder="docs/plan.md" aria-label="New page path" />
                <button className="btn primary" type="submit" disabled={!newPath.trim()}>New page</button>
              </form>
            )}
            {files === null && <p className="pages-empty">loading</p>}
            {files?.length === 0 && <p className="pages-empty">No pages yet.{canWrite ? " Make one above, or have your agent call write_page." : ""}</p>}
            {tree.map(([folder, list]) => (
              <div key={folder || "/"} className="pages-folder">
                {folder && <div className="menu-label h">{folder.toUpperCase().replace(/[^A-Z0-9/]+/g, "_")}</div>}
                {list.map((f) => (
                  <button key={f.path} className={`pages-item${selected === f.path ? " active" : ""}`} onClick={() => void open(f.path)} title={`${f.path} · ${kb(f.size)} · ${f.updatedBy}, ${when(f.updatedAt)}`}>
                    {selected === f.path && <span className="pages-mark" aria-hidden="true">$</span>}
                    <span className="pages-item-name">{f.path.slice(folder ? folder.length + 1 : 0)}</span>
                    {!f.page && <span className="chip">file</span>}
                  </button>
                ))}
              </div>
            ))}
          </aside>

          <section className="pages-main">
            {!loaded && <div className="pages-empty pages-welcome">
              <h2 className="h">PAGES</h2>
              <p>A page is a Markdown file you, your team, and your agents write together. Pick one on the left{canWrite ? ", or make one" : ""}. Over MCP, agents use read_page, write_page, and edit_page on the same pages.</p>
            </div>}
            {loaded && (
              <>
                <div className="pages-head">
                  {renaming !== null
                    ? <form className="pages-rename" onSubmit={(e) => void rename(e)}><input className="field" value={renaming} onChange={(e) => setRenaming(e.target.value)} autoFocus aria-label="New path" /><button className="btn primary" type="submit">Rename</button><button className="btn ghost" type="button" onClick={() => setRenaming(null)}>Cancel</button></form>
                    : <h2 className="pages-title">{loaded.info.path}</h2>}
                  <span className="pages-meta">{kb(loaded.info.size)} · {loaded.info.type} · changed by {loaded.info.updatedBy === me.email ? "you" : loaded.info.updatedBy}, {when(loaded.info.updatedAt)}</span>
                  <span className="spacer" />
                  {loaded.text !== null && !editing && canWrite && <button className="btn primary" onClick={() => { setDraft(loaded.text ?? ""); setEditing(true); setViewingRev(null); }}>Edit</button>}
                  {editing && <button className="btn primary" onClick={() => void save()} disabled={busy || draft === loaded.text}>{busy ? "Saving…" : "Save"}</button>}
                  {editing && <button className="btn ghost" onClick={() => { setEditing(false); setDraft(""); }}>Cancel</button>}
                  {loaded.text !== null && !editing && <button className="btn" onClick={() => void showRevisions()}>Versions</button>}
                  {canWrite && !editing && renaming === null && <button className="btn" onClick={() => setRenaming(loaded.info.path)}>Rename</button>}
                  {canWrite && !editing && (
                    <button className={`btn danger${armedDelete ? " armed" : ""}`} onClick={() => { if (!armedDelete) { setArmedDelete(true); return; } void remove(); }} onBlur={() => setArmedDelete(false)}>
                      {armedDelete ? "Tap again to delete" : "Delete"}
                    </button>
                  )}
                  <a className="btn" href={api(`/api/files/${loaded.info.path.split("/").map(encodeURIComponent).join("/")}${q(id, "&download=1")}`)} download>Download</a>
                  {isMd && !editing && (
                    <span className="pages-export" aria-label="Export">
                      <a className="btn" href={api(`/api/files/${loaded.info.path.split("/").map(encodeURIComponent).join("/")}${q(id, "&format=html")}`)} download title="The page as a standalone HTML document">HTML</a>
                      <a className="btn" href={api(`/api/files/${loaded.info.path.split("/").map(encodeURIComponent).join("/")}${q(id, "&format=docx")}`)} download title="The page as a Word document">Word</a>
                      <button className="btn" title="Open the page as a document and print it, or save it as a PDF" onClick={() => {
                        const w = window.open(api(`/api/files/${loaded.info.path.split("/").map(encodeURIComponent).join("/")}${q(id, "&format=html&inline=1")}`), "_blank");
                        w?.addEventListener("load", () => w.print());
                      }}>Print / PDF</button>
                    </span>
                  )}
                </div>
                {note && <p className={`pages-note ${note.kind}`} role="status">{note.text}{note.reload && <> <button className="btn" onClick={() => location.reload()}>Reload</button></>}</p>}
                {viewingRev && (
                  <p className="pages-note" role="status">
                    An earlier version, from {when(viewingRev.at)} by {viewingRev.by}. {canWrite && <button className="btn" onClick={() => void restore()}>Put it in the editor</button>} <button className="btn ghost" onClick={() => setViewingRev(null)}>Back to now</button>
                  </p>
                )}
                {revisions && !viewingRev && (
                  <div className="pages-revisions">
                    <div className="menu-label h">VERSIONS</div>
                    {revisions.length === 0 ? <p className="pages-empty">No earlier versions yet.</p> : revisions.map((r) => (
                      <button key={r.etag} className="pages-item" onClick={() => void viewRevision(r.etag)}>{when(r.at)} · {r.by} · {kb(r.size)}</button>
                    ))}
                  </div>
                )}
                {editing ? (
                  <textarea ref={textarea} className="field pages-editor" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={isMd}
                    onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void save(); if (e.key === "Escape") { setEditing(false); setDraft(""); } }} />
                ) : text !== null ? (
                  isMd ? <div className="pages-body"><Markdown text={text} /></div> : <pre className="pages-body pages-pre">{text}</pre>
                ) : IMAGES.has(loaded.info.type) ? (
                  <img className="pages-image" src={api(`/api/files/${loaded.info.path.split("/").map(encodeURIComponent).join("/")}${q(id)}`)} alt={loaded.info.path} />
                ) : (
                  <p className="pages-empty">A {loaded.info.type} file, {kb(loaded.info.size)}. Download it above.</p>
                )}
              </>
            )}
            {!loaded && note && <p className={`pages-note ${note.kind}`} role="status">{note.text}</p>}
          </section>
        </div>
        <Footer />
      </div>
    </div>
  );
}
