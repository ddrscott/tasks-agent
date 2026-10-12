// The section nav, in the top bar after the board switcher: Board · Pages · Worksheets for
// the board on screen, so nobody types a path to get anywhere. The one you're on carries the
// `$` mark. Pages and Worksheets each open a menu listing what the board has, read when the
// menu opens (the same lists their screens show), and one tap lands on that page or sheet.
// On the Pages and Worksheets screens the same tap opens it in place.

import { useCallback, useState } from "react";
import type { FileInfo } from "../docs";
import type { SheetInfo } from "../sheets-shared";
import { api } from "./base";
import { Popover } from "./Board";

export type Section = "board" | "pages" | "sheets";

type Props = {
  /** The board on screen: its id, or null for your first. */
  board: string | null;
  myId: string;
  current: Section;
  onBoard(): void;
  /** The Pages screen; with a path, that page. */
  onPages(path?: string): void;
  /** The Worksheets screen; with a sheet, that worksheet (its id or name). */
  onSheets(sheet?: string): void;
};

const IconBoard = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true">
    <rect x="3" y="4" width="5" height="16" /><rect x="10" y="4" width="5" height="10" /><rect x="17" y="4" width="4" height="13" />
  </svg>
);
const IconPages = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true">
    <path d="M6 3h8l5 5v13H6z" /><path d="M14 3v5h5" /><path d="M9 13h7M9 17h7" />
  </svg>
);
const IconSheets = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" /><path d="M3 10h18M3 15h18M10 4v16" />
  </svg>
);

type Lists = { pages?: FileInfo[] | "error"; sheets?: SheetInfo[] | "error" };

export function SectionNav({ board, myId, current, onBoard, onPages, onSheets }: Props) {
  const [open, setOpen] = useState<"pages" | "sheets" | null>(null);
  const [lists, setLists] = useState<Lists>({});
  const id = board ?? myId;

  // Read the list each time its menu opens, so it says what's there now.
  const show = useCallback(async (which: "pages" | "sheets") => {
    setOpen(which);
    setLists((l) => ({ ...l, [which]: undefined }));
    try {
      const r = await fetch(api(which === "pages" ? `/api/files?board=${encodeURIComponent(id)}` : `/api/sheets?board=${encodeURIComponent(id)}`));
      if (!r.ok) throw new Error(String(r.status));
      const d = (await r.json()) as { files?: FileInfo[]; sheets?: SheetInfo[] };
      setLists((l) => ({ ...l, [which]: which === "pages" ? (d.files ?? []).filter((f) => f.page).sort((a, b) => a.path.localeCompare(b.path)) : d.sheets ?? [] }));
    } catch {
      setLists((l) => ({ ...l, [which]: "error" }));
    }
  }, [id]);

  const toggle = (which: "pages" | "sheets") => { if (open === which) setOpen(null); else void show(which); };
  const close = useCallback(() => setOpen(null), []);

  const pages = lists.pages;
  const sheets = lists.sheets;

  return (
    <nav className="section-nav" aria-label="Sections">
      <button className="btn" aria-current={current === "board" ? "page" : undefined} onClick={() => { if (current !== "board") onBoard(); }} title="The board's cards">
        <IconBoard /><span className="label">Board</span>
      </button>
      <div className="anchor">
        <button className="btn" aria-current={current === "pages" ? "page" : undefined} aria-haspopup="menu" aria-expanded={open === "pages"} onClick={() => toggle("pages")} title="The board's pages and files">
          <IconPages /><span className="label">Pages</span><span className="section-caret" aria-hidden="true">▾</span>
        </button>
        {open === "pages" && (
          <Popover menu label="Pages" onClose={close}>
            <div className="menu section-menu">
              <button role="menuitem" onClick={() => { close(); onPages(); }}>All pages{current === "pages" ? "" : " and files"}</button>
              {pages === undefined && <div className="section-note">loading</div>}
              {pages === "error" && <div className="section-note">The list didn't load.</div>}
              {Array.isArray(pages) && pages.length === 0 && <div className="section-note">No pages yet. Make one on the Pages screen, or have your agent call write_page.</div>}
              {Array.isArray(pages) && pages.length > 0 && <div className="menu-label h">PAGES</div>}
              {Array.isArray(pages) && pages.map((f) => (
                <button key={f.path} role="menuitem" className="section-item" title={`${f.path} · ${f.updatedBy}`} onClick={() => { close(); onPages(f.path); }}>{f.path}</button>
              ))}
            </div>
          </Popover>
        )}
      </div>
      <div className="anchor">
        <button className="btn" aria-current={current === "sheets" ? "page" : undefined} aria-haspopup="menu" aria-expanded={open === "sheets"} onClick={() => toggle("sheets")} title="The board's worksheets">
          <IconSheets /><span className="label">Worksheets</span><span className="section-caret" aria-hidden="true">▾</span>
        </button>
        {open === "sheets" && (
          <Popover menu label="Worksheets" onClose={close}>
            <div className="menu section-menu">
              <button role="menuitem" onClick={() => { close(); onSheets(); }}>All worksheets</button>
              {sheets === undefined && <div className="section-note">loading</div>}
              {sheets === "error" && <div className="section-note">The list didn't load.</div>}
              {Array.isArray(sheets) && sheets.length === 0 && <div className="section-note">No worksheets yet. Make one on the Worksheets screen, import a CSV, or have your agent call create_sheet.</div>}
              {Array.isArray(sheets) && sheets.length > 0 && <div className="menu-label h">WORKSHEETS</div>}
              {Array.isArray(sheets) && sheets.map((s) => (
                <button key={s.id} role="menuitem" className="section-item" title={`${s.rows} ${s.rows === 1 ? "row" : "rows"} · ${s.updatedBy}`} onClick={() => { close(); onSheets(s.id); }}>
                  {s.name}<span className="section-item-sub">{s.rows}</span>
                </button>
              ))}
            </div>
          </Popover>
        )}
      </div>
    </nav>
  );
}
