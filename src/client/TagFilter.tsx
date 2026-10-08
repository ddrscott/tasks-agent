// The tag filter, in the top bar: a combo box that takes cards off the board, the way a WHERE
// clause keeps rows out of a result. Pick one tag or several and every card without them is gone
// from its lane until the filter is cleared. That's the difference from clicking a tag on a
// card, which only fades the others (README, Tags). Type to narrow the list, arrows to move,
// Enter to tick. `f` opens it from anywhere on the board. The filter belongs to the tab and
// isn't saved, and it isn't drawn at all on a board with no tags.

import { useEffect, useMemo, useRef, useState } from "react";
import { tagsByUse, type Board, type TagWhere } from "../shared";
import { Popover } from "./Board";
import { IconCheck, IconSearch } from "./icons";

export const NO_TAGS: TagWhere = { tags: [], all: false };

/** The filter's state for a board. A picked tag that's left the board drops out, so it can't hide everything with no row to untick. */
export function useTagWhere(board: Board | null): [TagWhere, (w: TagWhere) => void] {
  const [picked, setPicked] = useState<TagWhere>(NO_TAGS);
  const where = useMemo(() => {
    if (!board || !picked.tags.length) return picked;
    const known = new Set(tagsByUse(board));
    const tags = picked.tags.filter((t) => known.has(t));
    return tags.length === picked.tags.length ? picked : { ...picked, tags };
  }, [board, picked]);
  return [where, setPicked];
}

type Props = { board: Board; where: TagWhere; onChange(w: TagWhere): void };

export function TagFilter({ board, where, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  // Alphabetical, so a tag is where you'd look for it; the count is cards on the whole board.
  const tags = useMemo(() => {
    const n = new Map<string, number>();
    for (const c of board.cards) for (const t of c.tags ?? []) n.set(t, (n.get(t) ?? 0) + 1);
    return tagsByUse(board).sort((a, b) => a.localeCompare(b)).map((tag) => ({ tag, count: n.get(tag) ?? 0 }));
  }, [board]);

  const has = tags.length > 0;
  useEffect(() => {
    if (!has) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "f" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable]") || document.querySelector("dialog[open]")) return;
      e.preventDefault();
      setOpen(true);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [has]);
  useEffect(() => { if (!open) { setQ(""); setActive(0); } }, [open]);
  useEffect(() => { list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" }); }, [active]);

  if (!has) return null;

  const needle = q.trim().toLowerCase().replace(/^#/, "");
  const shown = needle ? tags.filter((t) => t.tag.includes(needle)) : tags;
  const picked = new Set(where.tags);
  const toggle = (tag: string) => onChange({ ...where, tags: picked.has(tag) ? where.tags.filter((t) => t !== tag) : [...where.tags, tag] });
  const clear = () => onChange({ ...where, tags: [] });
  // Row 0 is "All tags" while nothing is typed; the tags follow it.
  const rows = needle ? shown.length : shown.length + 1;
  const at = Math.min(active, Math.max(rows - 1, 0));
  const n = where.tags.length;

  return (
    <div className="anchor tag-filter">
      <button
        className={`btn tag-filter-btn${n ? " on" : ""}`} aria-haspopup="listbox" aria-expanded={open}
        title={n ? `Only cards tagged ${where.tags.map((t) => `#${t}`).join(where.all ? " and " : " or ")} are shown (f)` : "Show only the cards with certain tags (f)"}
        aria-label={n ? `Tag filter: ${where.tags.join(", ")}` : "Tag filter"}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="tag-filter-mark" aria-hidden="true">#</span>
        <span className="hide-sm label tag-filter-name">{n ? where.tags.join(where.all ? " + " : ", ") : "Tags"}</span>
        {n > 0 && <span className="tag-filter-n">{n}</span>}
        <span className="board-switch-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <Popover label="Filter by tag" onClose={() => setOpen(false)}>
          <div className="tag-combo">
            <label className="tag-combo-find">
              <IconSearch />
              <input
                autoFocus type="text" value={q} placeholder="Find a tag" aria-label="Find a tag" autoComplete="off" spellCheck={false}
                role="combobox" aria-expanded="true" aria-controls="tag-combo-list"
                onChange={(e) => { setQ(e.target.value); setActive(0); }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") { e.preventDefault(); setActive(Math.min(at + 1, rows - 1)); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(at - 1, 0)); }
                  else if (e.key === "Enter") {
                    e.preventDefault();
                    if (!needle && at === 0) clear();
                    else { const t = shown[needle ? at : at - 1]; if (t) toggle(t.tag); }
                  }
                }}
              />
            </label>
            <div className="tag-combo-list" id="tag-combo-list" role="listbox" aria-multiselectable="true" aria-label="Tags" ref={list}>
              {!needle && (
                <button role="option" aria-selected={n === 0} data-active={at === 0} tabIndex={-1} onMouseEnter={() => setActive(0)} onClick={clear}>
                  <span className="tag-combo-name">All tags</span>
                  {n === 0 && <IconCheck />}
                </button>
              )}
              {shown.map((t, i) => {
                const row = needle ? i : i + 1;
                return (
                  <button key={t.tag} role="option" aria-selected={picked.has(t.tag)} data-active={at === row} tabIndex={-1} onMouseEnter={() => setActive(row)} onClick={() => toggle(t.tag)}>
                    <span className="tag-combo-name">#{t.tag}</span>
                    <span className="tag-combo-count">{t.count}</span>
                    {picked.has(t.tag) && <IconCheck />}
                  </button>
                );
              })}
              {shown.length === 0 && <div className="search-note">No tag matches “{q.trim()}”.</div>}
            </div>
            <div className="tag-combo-foot">
              <span className="tag-combo-match" role="radiogroup" aria-label="A card has to carry">
                <span>match</span>
                <button role="radio" aria-checked={!where.all} title="Show a card that carries any of the picked tags" onClick={() => onChange({ ...where, all: false })}>any</button>
                <button role="radio" aria-checked={where.all} title="Show only a card that carries every picked tag" onClick={() => onChange({ ...where, all: true })}>all</button>
              </span>
              <button className="tag-combo-clear" disabled={n === 0} onClick={clear}>Clear</button>
            </div>
          </div>
        </Popover>
      )}
    </div>
  );
}
