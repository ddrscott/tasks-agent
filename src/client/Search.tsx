import { useEffect, useRef, useState } from "react";
import type { SearchHit, SearchResult } from "../tools";
import { IconSearch } from "./icons";

// The search box in the top bar (⌘K). Signed in, a query runs across every board you can
// reach, cards and pages alike (/api/search, // SEARCH); a hit says which board it's on when
// that isn't the one on screen, and opens the card or the page where it lives. The demo and
// an encrypted board search one board in the browser instead, with the same box.

/** Render text with \u0001…\u0002 marks from the search index as <mark>. */
function Marked({ text }: { text: string }) {
  const parts = text.split(/(\u0001[^\u0002]*\u0002)/g).filter(Boolean);
  return <>{parts.map((p, i) => (p.startsWith("\u0001") ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}</>;
}

type Props = {
  search(query: string): Promise<SearchResult>;
  onOpen(hit: SearchHit): void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** The board on screen: hits on it don't name a board. */
  here?: string;
};

export function SearchBox({ search, onOpen, inputRef, here }: Props) {
  const [q, setQ] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const seq = useRef(0);
  const box = useRef<HTMLDivElement>(null);

  // Debounced; a slower earlier query never overwrites a newer one.
  useEffect(() => {
    const query = q.trim();
    if (!query) { setResult(null); setBusy(false); return; }
    const n = ++seq.current;
    setBusy(true);
    const t = setTimeout(() => {
      search(query)
        .then((r) => { if (n === seq.current) { setResult(r); setActive(0); } })
        .catch(() => { if (n === seq.current) setResult({ hits: [], semantic: "unavailable" }); })
        .finally(() => { if (n === seq.current) setBusy(false); });
    }, 220);
    return () => clearTimeout(t);
  }, [q, search]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    addEventListener("pointerdown", onDown);
    return () => removeEventListener("pointerdown", onDown);
  }, []);

  const hits = result?.hits ?? [];
  function choose(h: SearchHit) {
    onOpen(h);
    setOpen(false);
    inputRef.current?.blur();
  }
  const meta = (h: SearchHit) => {
    const bits = [h.kind === "page" ? "page" : h.kind === "row" ? `row in ` : h.kind === "file" ? (h.card ? "attached to a card" : h.id) : h.lane];
    if (h.kind === "file" && h.page) bits.push(`page ${h.page}`);
    if (h.due) bits.push(`due ${h.due}`);
    if (h.assignee) bits.push(`assigned to ${h.assignee}`);
    if (h.match === "semantic") bits.push("similar meaning");
    return bits.join(" · ");
  };

  return (
    <div className="search" ref={box}>
      <IconSearch />
      <input
        ref={inputRef} type="search" value={q} placeholder="Search" aria-label="Search cards, pages, and files"
        role="combobox" aria-expanded={open && !!q.trim()} aria-controls="search-results"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === "Enter" && hits[active]) { e.preventDefault(); choose(hits[active]); }
          else if (e.key === "Escape") { if (q) setQ(""); else e.currentTarget.blur(); setOpen(false); }
        }}
      />
      <kbd className="hide-sm">⌘K</kbd>
      {open && q.trim() && (
        <div className="search-results popover" id="search-results" role="listbox">
          {busy && !result && <div className="search-note">searching</div>}
          {result && hits.length === 0 && <div className="search-note">Nothing matches “{q.trim()}”.</div>}
          {hits.map((h, i) => (
            <button
              key={`${h.board ?? ""}/${h.kind ?? "card"}/${h.id}/${h.att ?? ""}`} role="option" aria-selected={i === active} className="search-hit"
              onMouseEnter={() => setActive(i)} onClick={() => choose(h)}
            >
              <span className="search-title">
                {h.kind === "page" && <span className="search-kind">page</span>}
                {h.kind === "row" && <span className="search-kind">row</span>}
                {h.kind === "file" && <span className="search-kind">file</span>}
                <Marked text={h.title} />
              </span>
              {h.snippet && <span className="search-snippet">…<Marked text={h.snippet} />…</span>}
              <span className="search-meta">
                {h.board && h.board !== here && h.boardName && <span className="chip board-chip" title={h.boardName}>{h.boardName}</span>}
                {h.kind === "page" ? h.id : meta(h)}
              </span>
            </button>
          ))}
          {result?.semantic === "unavailable" && <div className="search-note">Showing keyword matches only.</div>}
        </div>
      )}
    </div>
  );
}
