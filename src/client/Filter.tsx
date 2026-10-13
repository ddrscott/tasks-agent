// The filter, one button beside search: every way to limit which cards show, in one panel.
// "Mine" is the first row, cards assigned to whoever is signed in. Under it, anyone with a card
// assigned on this board and "Unassigned", then the board's tags. A picked person or tag takes
// the other cards off the board, the way a WHERE clause keeps rows out of a result; that's the
// difference from clicking a tag on a card, which only fades the others (README, Tags). People
// and tags narrow together. Type to narrow the list, arrows to move, Enter to tick. `f` opens it
// from anywhere on the board. The filter lives in the address (`?who=me&tags=agent&match=all`),
// so a filtered board can be linked to and a reload keeps it. It all happens in the browser:
// nothing here asks the server for anything.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { filterQueryFrom, filterQueryInto, matchesWhere, tagsByUse, WHO_ME, WHO_NONE, type Board, type FilterQuery, type Where } from "../shared";
import { Popover } from "./Board";
import { IconCheck, IconClose, IconFilter, IconSearch } from "./icons";

const fromUrl = () => filterQueryFrom(location.search);
const isOn = (w: Where, fade: string | null) => w.who.length + w.tags.length + (fade ? 1 : 0);

export type Filters = {
  where: Where; setWhere(w: Where): void;
  /** The tag clicked on a card: cards without it fade back. */
  fade: string | null; setFade(t: string | null): void;
  /** Everything off at once. */
  clear(): void;
};

/**
 * A board's filters, kept in the address: the panel's pick (`where`) and the tag clicked on a
 * card (`fade`). A change replaces the address instead of adding to history, so Back still leaves
 * the board. A picked tag or person that's left the board drops out of what's shown, so it can't
 * hide everything with no row to untick. `me` is the email of whoever is looking: their own
 * address in a link reads as Mine.
 */
export function useFilters(board: Board | null, me: string | null): Filters {
  const [picked, setPicked] = useState<FilterQuery>(fromUrl);
  useEffect(() => {
    const onPop = () => setPicked(fromUrl());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  // Read the address again on each change: something else (a board switch) may have rewritten it.
  const change = useCallback((part: Partial<FilterQuery>) => {
    const next = { ...fromUrl(), ...part };
    history.replaceState(history.state, "", location.pathname + filterQueryInto(location.search, next) + location.hash);
    setPicked(next);
  }, []);
  const setWhere = useCallback((where: Where) => change({ where }), [change]);
  const setFade = useCallback((fade: string | null) => change({ fade }), [change]);
  const clear = useCallback(() => change({ where: { tags: [], all: false, who: [] }, fade: null }), [change]);
  const where = useMemo(() => {
    const w = picked.where;
    if (!board || !(w.tags.length || w.who.length)) return w;
    const knownTags = new Set(tagsByUse(board));
    const assigned = new Set(board.cards.map((c) => c.assignee));
    const tags = w.tags.filter((t) => knownTags.has(t));
    const who = [...new Set(w.who.map((p) => (p === me ? WHO_ME : p)))].filter((p) => p === WHO_ME || p === WHO_NONE || assigned.has(p));
    return tags.length === w.tags.length && who.length === w.who.length && who.every((p, i) => p === w.who[i]) ? w : { ...w, tags, who };
  }, [board, picked.where, me]);
  return { where, setWhere, fade: picked.fade, setFade, clear };
}

/** How a picked person reads on a chip: Mine, Unassigned, or the name before the @. */
const whoName = (w: string) => (w === WHO_ME ? "Mine" : w === WHO_NONE ? "Unassigned" : `→ ${w.split("@")[0]}`);

type Props = { board: Board; me: string | null; filters: Filters };
type Row = { key: string; kind: "who" | "tag"; value: string; name: string; note?: string; count: number; on: boolean };

export function FilterButton({ board, me, filters }: Props) {
  const { where, setWhere, fade, clear } = filters;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  // People are whoever has a card assigned here, A to Z, with the unassigned last. Tags are A to
  // Z too, so each is where you'd look for it; the counts are cards on the whole board.
  const { mine, people, unassigned, tags } = useMemo(() => {
    const byWho = new Map<string, number>(), byTag = new Map<string, number>();
    let unassigned = 0;
    for (const c of board.cards) {
      if (c.assignee) byWho.set(c.assignee, (byWho.get(c.assignee) ?? 0) + 1); else unassigned += 1;
      for (const t of c.tags ?? []) byTag.set(t, (byTag.get(t) ?? 0) + 1);
    }
    const people = [...byWho].filter(([email]) => email !== me).sort((a, b) => a[0].localeCompare(b[0]));
    const tags = tagsByUse(board).sort((a, b) => a.localeCompare(b)).map((tag) => ({ tag, count: byTag.get(tag) ?? 0 }));
    return { mine: me ? byWho.get(me) ?? 0 : 0, people, unassigned, tags, };
  }, [board, me]);
  // On a board where nobody is assigned anything, the people rows aren't drawn: Mine and the tags are.
  const anyAssigned = mine > 0 || people.length > 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "f" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable]") || document.querySelector("dialog[open]")) return;
      e.preventDefault();
      setOpen(true);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => { if (!open) { setQ(""); setActive(0); } }, [open]);
  useEffect(() => { list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" }); }, [active]);

  const who = new Set(where.who), picked = new Set(where.tags);
  const all: Row[] = [
    ...(me ? [{ key: "who:me", kind: "who" as const, value: WHO_ME, name: "Mine", note: "assigned to you", count: mine, on: who.has(WHO_ME) }] : []),
    ...(anyAssigned ? [
      ...people.map(([email, count]) => ({ key: `who:${email}`, kind: "who" as const, value: email, name: email, count, on: who.has(email) })),
      { key: "who:none", kind: "who" as const, value: WHO_NONE, name: "Unassigned", count: unassigned, on: who.has(WHO_NONE) },
    ] : []),
    ...tags.map((t) => ({ key: `tag:${t.tag}`, kind: "tag" as const, value: t.tag, name: `#${t.tag}`, count: t.count, on: picked.has(t.tag) })),
  ];
  // A # in front looks only at tags, the way a tag is typed everywhere else.
  const typed = q.trim().toLowerCase();
  const needle = typed.replace(/^#/, "");
  const rows = !needle ? all : all.filter((r) => (r.kind === "tag" ? r.value.includes(needle) : !typed.startsWith("#") && r.name.toLowerCase().includes(needle)));
  const at = Math.min(active, Math.max(rows.length - 1, 0));
  const toggle = (r: Row) => {
    const flip = (have: string[]) => (have.includes(r.value) ? have.filter((v) => v !== r.value) : [...have, r.value]);
    setWhere(r.kind === "who" ? { ...where, who: flip(where.who) } : { ...where, tags: flip(where.tags) });
  };
  const n = isOn(where, fade);
  const said = [...where.who.map(whoName), ...where.tags.map((t) => `#${t}`), ...(fade ? [`#${fade} (faded)`] : [])].join(", ");

  const row = (r: Row) => {
    const i = rows.indexOf(r);
    return (
      <button key={r.key} role="option" aria-selected={r.on} data-active={at === i} tabIndex={-1} onMouseEnter={() => setActive(i)} onClick={() => toggle(r)}>
        <span className="filter-row-name">{r.name}{r.note && <span className="filter-row-note">{r.note}</span>}</span>
        <span className="filter-row-count">{r.count}</span>
        {r.on && <IconCheck />}
      </button>
    );
  };
  const mineRow = rows.find((r) => r.value === WHO_ME && r.kind === "who");
  const peopleRows = rows.filter((r) => r.kind === "who" && r !== mineRow);
  const tagRows = rows.filter((r) => r.kind === "tag");

  return (
    <div className="anchor filter">
      <button
        className={`btn filter-btn${n ? " on" : ""}`} aria-haspopup="dialog" aria-expanded={open}
        title={n ? `Showing only ${said}. Change the filter (f)` : "Show only your cards, one person's, or a tag's (f)"}
        aria-label={n ? `Filter, ${n} on: ${said}` : "Filter"}
        onClick={() => setOpen((o) => !o)}
      >
        <IconFilter />
        <span className="hide-sm label">Filter</span>
        {n > 0 && <span className="filter-n"><span aria-hidden="true">$</span>{n}</span>}
      </button>
      {open && (
        <Popover label="Filter cards" onClose={() => setOpen(false)}>
          <div className="filter-panel">
            <label className="filter-find">
              <IconSearch />
              <input
                autoFocus type="text" value={q} placeholder={anyAssigned ? "Find a person or a tag" : "Find a tag"} aria-label="Find a person or a tag" autoComplete="off" spellCheck={false}
                role="combobox" aria-expanded="true" aria-controls="filter-list"
                onChange={(e) => { setQ(e.target.value); setActive(0); }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") { e.preventDefault(); setActive(Math.min(at + 1, rows.length - 1)); }
                  else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(at - 1, 0)); }
                  else if (e.key === "Enter") { e.preventDefault(); if (rows[at]) toggle(rows[at]); }
                }}
              />
            </label>
            <div className="filter-list" id="filter-list" role="listbox" aria-multiselectable="true" aria-label="Filters" ref={list}>
              {mineRow && row(mineRow)}
              {/* Mine with nothing behind it would empty the board, so say why before it's clicked. */}
              {mineRow && mine === 0 && (
                <div className="filter-hint">
                  {anyAssigned ? "Nothing on this board is assigned to you." : "No card on this board is assigned to anyone yet."} A card gets its person from Assign to, in the card's editor.
                </div>
              )}
              {peopleRows.length > 0 && (
                <div role="group" aria-label="People">
                  <div className="menu-label h">PEOPLE</div>
                  {peopleRows.map(row)}
                </div>
              )}
              {tagRows.length > 0 && (
                <div role="group" aria-label="Tags">
                  <div className="menu-label h">TAGS</div>
                  {tagRows.map(row)}
                </div>
              )}
              {rows.length === 0 && <div className="search-note">Nothing matches “{q.trim()}”.</div>}
            </div>
            <div className="filter-foot">
              {tags.length > 0 ? (
                <span className="filter-match" role="radiogroup" aria-label="A card has to carry">
                  <span>tags match</span>
                  <button role="radio" aria-checked={!where.all} title="Show a card that carries any of the picked tags" onClick={() => setWhere({ ...where, all: false })}>any</button>
                  <button role="radio" aria-checked={where.all} title="Show only a card that carries every picked tag" onClick={() => setWhere({ ...where, all: true })}>all</button>
                </span>
              ) : <span />}
              <button className="filter-clear" disabled={n === 0} onClick={clear}>Clear all</button>
            </div>
          </div>
        </Popover>
      )}
    </div>
  );
}

/**
 * The line under the top bar while a filter is on: how many cards are showing out of how many,
 * each filter as a chip that one click takes off, and Clear all. It's what says the missing
 * cards are hidden and not gone. Nothing is drawn while no filter is on.
 */
export function FilterLine({ board, me, filters }: Props) {
  const { where, setWhere, fade, setFade, clear } = filters;
  if (!isOn(where, fade)) return null;
  const total = board.cards.length;
  const shown = board.cards.filter((c) => matchesWhere(c, where, me)).length;
  const narrowed = where.who.length + where.tags.length > 0;
  const mine = where.who.includes(WHO_ME) && !!me && !board.cards.some((c) => c.assignee === me);
  return (
    <aside className="filter-line" role="status" aria-label="Filter">
      <span className="filter-line-mark" aria-hidden="true">$</span>
      <span className="filter-line-say">
        {narrowed ? <><b>{shown} of {total}</b> cards shown</> : <><b>{total}</b> cards, some faded</>}
      </span>
      <span className="filter-chips">
        {where.who.map((w) => (
          <button key={`who:${w}`} className="chip tag active" title={`${w === WHO_ME ? "Cards assigned to you" : w === WHO_NONE ? "Cards assigned to nobody" : `Cards assigned to ${w}`}. Click to take this off`} onClick={() => setWhere({ ...where, who: where.who.filter((x) => x !== w) })}>
            {whoName(w)}<IconClose />
          </button>
        ))}
        {where.tags.length > 1 && <span className="filter-join">{where.all ? "all of" : "any of"}</span>}
        {where.tags.map((t) => (
          <button key={`tag:${t}`} className="chip tag active" title={`Cards tagged #${t}. Click to take this off`} onClick={() => setWhere({ ...where, tags: where.tags.filter((x) => x !== t) })}>
            #{t}<IconClose />
          </button>
        ))}
        {fade && (
          <button className="chip tag active" title={`Cards without #${fade} are faded. Click to show every card`} onClick={() => setFade(null)}>
            <span className="filter-join">fade</span>#{fade}<IconClose />
          </button>
        )}
      </span>
      <button className="filter-clear" onClick={clear}>Clear all</button>
      {mine && <span className="filter-line-hint">Nothing here is assigned to you. A card gets its person from Assign to, in the card's editor.</span>}
    </aside>
  );
}
