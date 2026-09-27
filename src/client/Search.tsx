import { useEffect, useRef, useState } from "react";
import type { SearchHit, SearchResult } from "../tools";
import { IconSearch } from "./icons";

// The search box in the top bar (⌘K). Queries run in the user's agent (TodoAgent.search),
// which mixes keyword and meaning-based matches; results open the card.

/** Render text with \u0001…\u0002 marks from the search index as <mark>. */
function Marked({ text }: { text: string }) {
  const parts = text.split(/(\u0001[^\u0002]*\u0002)/g).filter(Boolean);
  return <>{parts.map((p, i) => (p.startsWith("\u0001") ? <mark key={i}>{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}</>;
}

type Props = {
  search(query: string): Promise<SearchResult>;
  onOpen(cardId: string): void;
  inputRef: React.RefObject<HTMLInputElement | null>;
};

export function SearchBox({ search, onOpen, inputRef }: Props) {
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
    onOpen(h.id);
    setOpen(false);
    inputRef.current?.blur();
  }

  return (
    <div className="search" ref={box}>
      <IconSearch />
      <input
        ref={inputRef} type="search" value={q} placeholder="Search tasks" aria-label="Search tasks"
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
          {result && hits.length === 0 && <div className="search-note">No cards match “{q.trim()}”.</div>}
          {hits.map((h, i) => (
            <button
              key={h.id} role="option" aria-selected={i === active} className="search-hit"
              onMouseEnter={() => setActive(i)} onClick={() => choose(h)}
            >
              <span className="search-title"><Marked text={h.title} /></span>
              {h.snippet && <span className="search-snippet">…<Marked text={h.snippet} />…</span>}
              <span className="search-meta">{h.lane}{h.due ? ` · due ${h.due}` : ""}{h.match === "semantic" ? " · similar meaning" : ""}</span>
            </button>
          ))}
          {result?.semantic === "unavailable" && <div className="search-note">Showing keyword matches only.</div>}
        </div>
      )}
    </div>
  );
}
