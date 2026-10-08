import {
  closestCorners, DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor,
  useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { doneLaneId, faceLine, LANE_ROLES, matchesTags, roleOf, statusLine, hasTag, shownCards, SORTS, todoLaneId, type Board, type Card, type Lane, type LaneRole, type SortBy, type TagWhere } from "../shared";
import { IconCalendar, IconCheck, IconClip, IconDots, IconNotes, IconPlus, IconUndo } from "./icons";
import { AskBlock, AskOwnerContext } from "./Ask";
import { agentHeld, ByFace, type Mode } from "./member";
import { AgentNudge, NoAgentChip } from "./AgentNudge";
import { Unsaved, useDraft } from "./Unsaved";

/** What quick add hears back: how many lines became cards, the lines that didn't (as typed), and why not. */
/** `fix` is the lines in `left` that will be refused again exactly as they are (needsEdit in member-rules.ts): they have to be edited first. */
export type AddResult = { added: number; left: string[]; why: string | null; fix?: string[] };

export type Actions = {
  /** Quick add: one card per line, as one change. Lines that can't be added come back in `left`. */
  addCards(laneId: string, lines: string[]): Promise<AddResult>;
  moveCard(id: string, laneId: string, index: number): Promise<unknown>;
  addLane(name: string): Promise<unknown>;
  renameLane(id: string, name: string): Promise<unknown>;
  deleteLane(id: string): Promise<unknown>;
  moveLane(id: string, index: number): Promise<unknown>;
  clearLane(id: string): Promise<unknown>;
  /** Put the lane in this order and turn its saved sort off, in one step. */
  setLaneManual(id: string, ids: string[]): Promise<unknown>;
  /** Keep the lane sorted by `by` from now on; null goes back to manual order. */
  setLaneSort(id: string, by: SortBy | null): Promise<unknown>;
  /** Make a lane the to do, doing, or done lane; null for an ordinary lane. */
  setLaneRole(id: string, role: LaneRole | null): Promise<unknown>;
};

type Props = {
  board: Board;
  actions: Actions;
  flash: Set<string>;
  /** Cards without this tag fade back. */
  tagFilter: string | null;
  onTag(tag: string): void;
  /** The tag filter in the top bar (TagFilter.tsx). Cards it doesn't match aren't drawn at all. */
  where?: TagWhere;
  /** Open the full New card dialog for a lane. */
  onNew(laneId: string): void;
  quickAddLane: string | null;
  setQuickAddLane(id: string | null): void;
  onOpen(card: Card): void;
  onOptimistic(board: Board): void;
  onDragging(active: boolean): void;
  /** `ms` is how long it stays; destructive actions ask for longer than the default. */
  toast(text: string, undo?: boolean, ms?: number): void;
  /**
   * What the person looking may do here (// TEAM_BOARDS). Left out, it's the owner's board:
   * everything. A writer gets cards and no lane controls. A viewer gets a board with nothing
   * on it that changes anything: cards don't lift, and there's no add, no check, no menu.
   */
  mode?: Mode;
  /**
   * Set when the board turned view only while someone could have been typing (made a viewer,
   * the owner's plan lapsed): why, in a sentence. A lane's "Add a card" box that has text in
   * it shows that text read only under it, to copy out, instead of vanishing.
   */
  frozen?: string | null;
};

const LANE_PREFIX = "lane:";
/** How long the toast stays after something was deleted: long enough to notice and reach Undo. */
export const DESTRUCTIVE_TOAST_MS = 10_000;
const count = (n: number, word = "card") => `${n} ${word}${n === 1 ? "" : "s"}`;

// On a narrow screen the board shows one lane at a time and snaps to it (styles.css, max-width:
// 900px). There, holding a dragged card in the strip along either side edge brings in the next
// lane, one lane per hold. dnd-kit's own auto-scroll speeds up the longer it runs, and against
// scroll snap it ran from the first lane to the last in half a second.
const SNAPS = "(max-width: 900px)";
const EDGE_PX = 44;
/** How long the card rests at the edge before the board moves one lane. */
const EDGE_DWELL_MS = 400;
/** Still holding at the edge this long after a step moves one more lane. Long enough to see where you are and let go. */
const EDGE_AGAIN_MS = 2500;
const snaps = () => matchMedia(SNAPS).matches;
const edgeSide = (x: number) => (x < EDGE_PX ? -1 : x > innerWidth - EDGE_PX ? 1 : 0);
const laneEls = () => [...document.querySelectorAll<HTMLElement>(".board > [data-lane-id]")];

/** Scroll the board one lane left (-1) or right (1) of the lane it's showing. */
function stepBoard(side: number) {
  const boardEl = document.querySelector<HTMLElement>(".board");
  const els = laneEls();
  if (!boardEl || !els.length) return;
  const pad = parseFloat(getComputedStyle(boardEl).scrollPaddingLeft) || 0;
  const origin = boardEl.getBoundingClientRect().left + pad;
  const lefts = els.map((el) => el.getBoundingClientRect().left - origin);
  const at = lefts.reduce((best, l, i) => (Math.abs(l) < Math.abs(lefts[best]) ? i : best), 0);
  const to = Math.min(els.length - 1, Math.max(0, at + side));
  if (to === at) return;
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  boardEl.scrollTo({ left: boardEl.scrollLeft + lefts[to], behavior: calm ? "auto" : "smooth" });
}

export function BoardView(p: Props) {
  const { board } = p;
  const mode = p.mode ?? "owner";
  const owner = useContext(AskOwnerContext);
  const [drag, setDrag] = useState<{ id: string; cards: Card[] } | null>(null);
  const cards = drag?.cards ?? board.cards;
  // Done is a role a lane holds (lanes.ts), not the last place on the board.
  const doneLane = doneLaneId(board.lanes);

  // Where the finger or mouse is while a card is held. dnd-kit reports movement with the board's
  // scrolling folded in, so the screen position is tracked here. Null for a keyboard drag.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const dragging = !!drag;
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent | TouchEvent) => {
      const at = "touches" in e ? e.touches[0] : e;
      if (at) pointer.current = { x: at.clientX, y: at.clientY };
    };
    addEventListener("pointermove", move, { passive: true });
    addEventListener("touchmove", move, { passive: true });
    let side = 0, since = 0, wait = EDGE_DWELL_MS;
    const timer = setInterval(() => {
      const now = Date.now();
      const s = pointer.current && snaps() ? edgeSide(pointer.current.x) : 0;
      if (s !== side) { side = s; since = now; wait = EDGE_DWELL_MS; return; }
      if (!side || now - since < wait) return;
      stepBoard(side);
      since = now;
      wait = EDGE_AGAIN_MS;
    }, 100);
    return () => {
      removeEventListener("pointermove", move);
      removeEventListener("touchmove", move);
      clearInterval(timer);
      pointer.current = null;
    };
  }, [dragging]);

  // Which lane a held card is over. On a wide board, the nearest lane or card, as before. On a
  // snapping board it's the lane under the finger, except in the edge strips: those are for
  // bringing in the next lane, and the sliver of it that peeks in there isn't a target, so the
  // card belongs to the lane filling the screen.
  const collision: CollisionDetection = (args) => {
    const at = pointer.current;
    if (!at || !snaps()) return closestCorners(args);
    const inEdge = edgeSide(at.x) !== 0;
    let lane: string | undefined;
    let best = -Infinity;
    for (const el of laneEls()) {
      const r = el.getBoundingClientRect();
      const score = inEdge
        ? Math.min(r.right, innerWidth) - Math.max(r.left, 0) // how much of it is on screen
        : -Math.max(r.left - at.x, at.x - r.right, 0); // how far the finger is from it
      if (score > best) { best = score; lane = el.dataset.laneId; }
    }
    if (!lane) return closestCorners(args);
    const inLane = args.droppableContainers.filter(
      (c) => c.id === LANE_PREFIX + lane || c.data.current?.sortable?.containerId === lane,
    );
    return closestCorners({ ...args, droppableContainers: inLane });
  };

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    // Space picks a card up; Enter stays free to open the editor.
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );

  const laneOf = (id: string, list: Card[]) =>
    id.startsWith(LANE_PREFIX) ? id.slice(LANE_PREFIX.length) : list.find((c) => c.id === id)?.laneId;

  function onDragStart(e: DragStartEvent) {
    const ev = e.activatorEvent;
    const at = "touches" in ev ? (ev as TouchEvent).touches[0] : "clientX" in ev ? (ev as MouseEvent) : null;
    pointer.current = at ? { x: at.clientX, y: at.clientY } : null;
    // Start from what's on screen: a lane with a saved sort shows its cards in that order, not
    // in stored order, and the indexes worked out on drop have to mean the same thing.
    setDrag({ id: String(e.active.id), cards: board.lanes.flatMap((l) => shownCards(board, l.id)) });
    p.onDragging(true);
  }

  // Crossing into another lane moves the card there immediately, so the lane
  // opens a gap for it while you're still holding it.
  function onDragOver({ active, over }: DragOverEvent) {
    if (!over) return;
    setDrag((d) => {
      if (!d) return d;
      const from = laneOf(String(active.id), d.cards);
      const to = laneOf(String(over.id), d.cards);
      if (!from || !to || from === to) return d;
      const card = d.cards.find((c) => c.id === active.id)!;
      const rest = d.cards.filter((c) => c.id !== active.id);
      let at: number;
      if (String(over.id).startsWith(LANE_PREFIX)) {
        const inLane = rest.filter((c) => c.laneId === to);
        at = inLane.length ? rest.indexOf(inLane[inLane.length - 1]) + 1 : rest.length;
      } else {
        at = rest.findIndex((c) => c.id === over.id);
      }
      rest.splice(at, 0, { ...card, laneId: to });
      return { ...d, cards: rest };
    });
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    const d = drag;
    setDrag(null);
    p.onDragging(false);
    if (!d || !over) return;
    let next = d.cards;
    const id = String(active.id);
    if (!String(over.id).startsWith(LANE_PREFIX) && over.id !== active.id) {
      const a = next.findIndex((c) => c.id === id);
      const b = next.findIndex((c) => c.id === over.id);
      if (a !== -1 && b !== -1 && next[a].laneId === next[b].laneId) next = arrayMove(next, a, b);
    }
    const lane = next.find((c) => c.id === id)!.laneId;
    const inLane = next.filter((c) => c.laneId === lane);
    const index = inLane.findIndex((c) => c.id === id);
    const before = board.cards.find((c) => c.id === id)!;
    const beforeIndex = shownCards(board, before.laneId).findIndex((c) => c.id === id);
    if (before.laneId === lane && beforeIndex === index) return;
    const target = board.lanes.find((l) => l.id === lane);
    // Two things a writer's drag can't do, said here because the server would refuse them:
    // reorder a sorted lane (that changes the lane's sort, which is the owner's), and finish a
    // card whose question the owner hasn't answered. The card goes back where it was.
    if (mode !== "owner" && target?.sort && before.laneId === lane) {
      p.toast(`${target.name} is sorted by ${SORTS.find((o) => o.by === target.sort)?.say ?? "a rule"}. Only the board's owner can change its order.`);
      return;
    }
    if (mode !== "owner" && before.ask && lane === doneLane && before.laneId !== doneLane) {
      p.toast(`That card has a question waiting on ${owner ?? "the board's owner"}, so it can't be finished yet.`);
      return;
    }
    if (target?.sort && before.laneId === lane) {
      // Dragging a card to a new spot in a sorted lane is choosing your own order, so the lane goes
      // back to manual and keeps exactly what's on screen.
      p.onOptimistic({ ...board, cards: next, lanes: board.lanes.map((l) => (l.id === lane ? { id: l.id, name: l.name } : l)) });
      void p.actions.setLaneManual(lane, inLane.map((c) => c.id)).then(() => p.toast(`${target.name} is in manual order now`, true));
      return;
    }
    // A card dropped into a sorted lane from another one takes its sorted place, wherever it was let go.
    p.onOptimistic({ ...board, cards: next });
    void p.actions.moveCard(id, lane, index);
  }

  /** Done means "in the done lane": send the card there, or back to the top of the to do lane. */
  function toggleDone(card: Card, fromKeyboard = false) {
    const target = card.laneId === doneLane ? todoLaneId(board.lanes) : doneLane;
    if (!target || target === card.laneId || mode === "viewer") return;
    if (mode === "writer" && card.ask && target === doneLane) {
      p.toast(`That card has a question waiting on ${owner ?? "the board's owner"}, so it can't be finished yet.`);
      return;
    }
    void p.actions.moveCard(card.id, target, card.laneId === doneLane ? 0 : Number.MAX_SAFE_INTEGER);
    // The card remounts in its new lane, which drops keyboard focus; follow it there.
    if (fromKeyboard) {
      let tries = 0;
      const refocus = () => {
        const el = document.querySelector<HTMLElement>(`[data-card-id="${card.id}"]`);
        if (el?.closest(`[data-lane-id="${target}"]`)) el.focus();
        else if (++tries < 20) setTimeout(refocus, 50);
      };
      setTimeout(refocus, 50);
    }
  }

  const active = drag ? cards.find((c) => c.id === drag.id) : undefined;

  return (
    <DndContext
      sensors={sensors} collisionDetection={collision}
      // The edge stepper above scrolls a snapping board sideways; dnd-kit still scrolls a long lane up and down.
      autoScroll={{ canScroll: (el) => !(snaps() && el.classList.contains("board")) }}
      onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}
      onDragCancel={() => { setDrag(null); p.onDragging(false); }}
    >
      {/* "No agent connected yet", until one is (AgentNudge.tsx). */}
      {mode === "owner" && <AgentNudge board={board} say={p.toast} />}
      <div className="board" data-mode={mode === "owner" ? undefined : mode}>
        {board.lanes.map((lane, i) => (
          <LaneView
            key={lane.id} lane={lane} index={i} lanes={board.lanes}
            cards={drag ? cards.filter((c) => c.laneId === lane.id) : shownCards(board, lane.id)}
            isDone={lane.id === doneLane} role={roleOf(board.lanes, lane.id)} hasDone={!!doneLane}
            highlight={!!active && active.laneId === lane.id}
            {...p} mode={mode} onToggle={toggleDone}
          />
        ))}
        {mode === "owner" && <AddLane onAdd={(name) => p.actions.addLane(name)} full={board.lanes.length >= 8} />}
      </div>
      <DragOverlay dropAnimation={{ duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" }}>
        {active && <CardFace card={active} isDone={active.laneId === doneLane} overlay />}
      </DragOverlay>
    </DndContext>
  );
}

function LaneView(props: Props & {
  lane: Lane; index: number; lanes: Lane[]; cards: Card[]; isDone: boolean; role: LaneRole | undefined; hasDone: boolean; highlight: boolean; onToggle(c: Card): void;
}) {
  const { lane, cards, actions } = props;
  // Lanes are the owner's: a member sees the name, the count, and the sort, with nothing to press.
  const owns = (props.mode ?? "owner") === "owner";
  const canCards = props.mode !== "viewer";
  const { setNodeRef } = useDroppable({ id: LANE_PREFIX + lane.id });
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState(false);
  // Clear and Delete take two taps on the same item: the first only changes its label to say
  // what the second will do. Closing the menu, however it closes, starts over.
  const [armed, setArmed] = useState<"clear" | "delete" | null>(null);
  useEffect(() => { if (!menu) setArmed(null); }, [menu]);
  const adding = props.quickAddLane === lane.id;
  // The tag filter takes cards out of the lane; `cards` stays the whole lane, for the count and the menu.
  const where = props.where?.tags.length ? props.where : null;
  const shown = where ? cards.filter((c) => matchesTags(c, where)) : cards;
  const matching = props.tagFilter ? shown.filter((c) => hasTag(c, props.tagFilter!)).length : shown.length;

  function commitRename(value: string) {
    if (!renaming) return;
    const v = value.trim();
    if (v && v !== lane.name) void actions.renameLane(lane.id, v);
    setRenaming(false);
  }

  // The sort is a setting on the lane, saved with the board: it holds across reloads and
  // browsers, and cards added or changed later fall into place (shownCards in shared.ts).
  function sort(by: SortBy | null, say: string) {
    setMenu(false);
    if ((lane.sort ?? null) === by) return;
    void actions.setLaneSort(lane.id, by).then(() => props.toast(by ? `${lane.name} stays sorted by ${say}` : `${lane.name} is in manual order`, true));
  }
  const sortedBy = SORTS.find((o) => o.by === lane.sort);

  // To do, doing, and done are roles; one lane each. Handing one over takes it from the lane that had it.
  function setRole(role: LaneRole | null) {
    setMenu(false);
    const say = role ? `${lane.name} is now ${LANE_ROLES.find((r) => r.role === role)!.say}` : `${lane.name} is an ordinary lane now`;
    void actions.setLaneRole(lane.id, role).then(() => props.toast(say, true));
  }

  return (
    <section
      className={`lane${props.highlight ? " over" : ""}`}
      style={{ viewTransitionName: `lane-${lane.id}`, ["--lane-color" as string]: `var(--lane-${(props.index % 4) + 1})` }}
      aria-label={lane.name}
      data-lane-id={lane.id}
    >
      <header className="lane-head">
        <span className="lane-dot" />
        {!owns ? (
          <span className="lane-name static">{lane.name}</span>
        ) : renaming ? (
          <input
            className="lane-name" autoFocus defaultValue={lane.name} maxLength={40} aria-label="Lane name"
            onBlur={(e) => commitRename(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commitRename(e.currentTarget.value); if (e.key === "Escape") setRenaming(false); }}
          />
        ) : (
          <button className="lane-name" title="Rename" onClick={() => setRenaming(true)}>{lane.name}</button>
        )}
        {/* While a filter is on, the count says how many match, out of how many. */}
        {props.tagFilter || where ? (
          <span className="lane-count" title={`${matching} of ${cards.length} match ${[...(where?.tags ?? []), ...(props.tagFilter ? [props.tagFilter] : [])].map((t) => `#${t}`).join(", ")}`}>{matching} / {cards.length}</span>
        ) : (
          <span className="lane-count">{cards.length}</span>
        )}
        {/* Says why the cards are in this order, and that dragging one will change that. */}
        {sortedBy && <span className="lane-sort" title={owns ? `Sorted by ${sortedBy.say}. Change it from the lane menu.` : `Sorted by ${sortedBy.say}. The board's owner sets the order.`}>by {sortedBy.say}</span>}
        <span className="spacer" />
        {canCards && <button className="btn ghost icon" title={`New card in ${lane.name}`} aria-label={`New card in ${lane.name}`} onClick={() => props.onNew(lane.id)}><IconPlus /></button>}
        {owns && (
        <div className="anchor">
          <button className="btn ghost icon" title="Lane options" aria-label={`${lane.name} lane options`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}><IconDots /></button>
          {menu && (
            <Popover menu label={`${lane.name} lane options`} onClose={() => setMenu(false)}>
              <div className="menu">
                <button role="menuitem" onClick={() => { setMenu(false); setRenaming(true); }}>Rename</button>
                {props.index > 0 && <button role="menuitem" onClick={() => { setMenu(false); void actions.moveLane(lane.id, props.index - 1); }}>Move left</button>}
                {props.index < props.lanes.length - 1 && <button role="menuitem" onClick={() => { setMenu(false); void actions.moveLane(lane.id, props.index + 1); }}>Move right</button>}
                <div className="menu-group" role="group" aria-label="Sort by">
                  <div className="menu-label h">SORT_BY</div>
                  {SORTS.map((o) => (
                    <button key={o.by} role="menuitemradio" aria-checked={lane.sort === o.by} onClick={() => sort(o.by, o.say)}>{o.label}</button>
                  ))}
                  <button role="menuitemradio" aria-checked={!sortedBy} onClick={() => sort(null, "")}>Manual order</button>
                </div>
                {/* Which lane new cards land in, which holds work in progress, and which means finished. Where a lane sits has no say. */}
                <div className="menu-group" role="group" aria-label="This lane is">
                  <div className="menu-label h">THIS_LANE_IS</div>
                  {/* One row, so the menu stays short. Tap the lit one to make this an ordinary lane again. */}
                  <div className="menu-roles">
                    {LANE_ROLES.map((r) => (
                      <button
                        key={r.role} role="menuitemcheckbox" aria-checked={props.role === r.role}
                        title={props.role === r.role ? `Tap to make ${lane.name} an ordinary lane` : `Make ${lane.name} ${r.say}`}
                        onClick={() => setRole(props.role === r.role ? null : r.role)}
                      >{r.label}</button>
                    ))}
                  </div>
                </div>
                {cards.length > 0 && (
                  <button
                    className={`danger${armed === "clear" ? " armed" : ""}`} role="menuitem"
                    onClick={() => {
                      if (armed !== "clear") { setArmed("clear"); return; }
                      const n = cards.length;
                      setMenu(false);
                      void actions.clearLane(lane.id).then(() => props.toast(`Cleared ${count(n)} from ${lane.name}`, true, DESTRUCTIVE_TOAST_MS));
                    }}
                  >
                    {armed === "clear" ? `Tap again to clear ${count(cards.length)}` : props.isDone ? "Clear finished cards" : "Clear all cards"}
                  </button>
                )}
                {props.lanes.length > 1 && (
                  <button
                    className={`danger${armed === "delete" ? " armed" : ""}`} role="menuitem"
                    onClick={() => {
                      if (armed !== "delete") { setArmed("delete"); return; }
                      const what = `${lane.name}${cards.length ? ` and its ${count(cards.length)}` : ""}`;
                      setMenu(false);
                      void actions.deleteLane(lane.id).then(() => props.toast(`Deleted ${what}`, true, DESTRUCTIVE_TOAST_MS));
                    }}
                  >
                    {armed === "delete" ? `Tap again to delete ${lane.name}${cards.length ? ` and its ${count(cards.length)}` : ""}` : "Delete lane"}
                  </button>
                )}
              </div>
            </Popover>
          )}
        </div>
        )}
      </header>

      <SortableContext id={lane.id} items={shown.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div className="cards" ref={setNodeRef}>
          {shown.map((c) => (
            <SortableCard
              key={c.id} card={c} isDone={props.isDone} flash={props.flash.has(c.id)} onOpen={props.onOpen} onToggle={props.onToggle}
              // No check for a viewer, and none for a writer on a card whose question is still open: the server refuses both.
              // An agent's work order doesn't lift or tick for a writer either, and says why on its face.
              canToggle={props.hasDone && canCards && !agentHeld(props.mode, c) && (owns || props.isDone || !c.ask)} locked={!canCards || agentHeld(props.mode, c)}
              held={agentHeld(props.mode, c)}
              faded={!!props.tagFilter && !hasTag(c, props.tagFilter)} tagFilter={props.tagFilter} onTag={props.onTag}
            />
          ))}
          {shown.length === 0 && cards.length > 0 && !adding && <div className="lane-empty">No cards match the tag filter</div>}
          {cards.length === 0 && !adding && (
            <div className="lane-empty">{!canCards ? "No cards" : props.index === 0 ? (owns ? "Nothing here yet. Add a card, or ask the assistant." : "Nothing here yet. Add a card.") : "Drag cards here"}</div>
          )}
        </div>
      </SortableContext>

      {/* Always mounted, so what's typed in it outlives the board turning view only. With nothing typed, a viewer's lane shows nothing here. */}
      <QuickAdd lane={lane} open={adding} setOpen={(o) => props.setQuickAddLane(o ? lane.id : null)} add={(lines) => actions.addCards(lane.id, lines)} tagHint={owns ? "#agent" : "a #tag"} frozen={canCards ? null : props.frozen ?? "This board is view only for you now."} />
    </section>
  );
}

function SortableCard(p: {
  card: Card; isDone: boolean; flash: boolean; canToggle: boolean; faded: boolean; tagFilter: string | null;
  /** A viewer's card, or an agent's work order on a writer's board: it opens, and that's all. */
  locked?: boolean;
  /** An agent's work order, as a writer sees it: the face says whose it is. */
  held?: boolean;
  onOpen(c: Card): void; onToggle(c: Card, fromKeyboard?: boolean): void; onTag(tag: string): void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: p.card.id, disabled: !!p.locked });
  return (
    <div
      // A viewer's card is a plain button that opens: none of the drag handlers or the "press space to pick up" instructions.
      ref={setNodeRef} {...(p.locked ? { role: "button", tabIndex: 0 } : attributes)} {...(p.locked ? {} : listeners)}
      style={{ transform: CSS.Translate.toString(transform), transition, viewTransitionName: isDragging ? undefined : `card-${p.card.id}` }}
      className={isDragging ? "dragging" : undefined}
      data-card-id={p.card.id}
      aria-roledescription={p.locked ? "card. Enter to open" : `card. Space to pick up, Enter to edit${p.canToggle ? `, X to mark ${p.isDone ? "not done" : "done"}` : ""}`}
      onClick={() => p.onOpen(p.card)}
      onKeyDown={(e) => {
        listeners?.onKeyDown?.(e);
        if (e.defaultPrevented) return;
        if (e.key === "Enter") p.onOpen(p.card);
        if (e.key.toLowerCase() === "x" && p.canToggle && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); p.onToggle(p.card, true); }
      }}
    >
      <CardFace {...p} onToggle={p.canToggle ? p.onToggle : undefined} dragging={isDragging} />
    </div>
  );
}

/** Exported so the signed-out landing page can draw sample cards with the real markup. */
export function CardFace(p: {
  card: Card; isDone: boolean; flash?: boolean; overlay?: boolean; dragging?: boolean; faded?: boolean; tagFilter?: string | null; held?: boolean;
  onToggle?(c: Card): void; onTag?(tag: string): void;
}) {
  const { card } = p;
  const status = !p.isDone && !card.ask ? faceLine(card) : null;
  const boardOwner = useContext(AskOwnerContext);
  const cls = ["card", p.isDone && "is-done", p.flash && "flash", p.overlay && "overlay", p.dragging && "dragging", p.faded && "faded"].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      {/* Shown on hover and keyboard focus only; the lane already says whether a card is done. */}
      {p.onToggle && !p.overlay && (
        <button
          className="done-btn" tabIndex={-1}
          title={p.isDone ? "Reopen: move back to the to do lane (x)" : "Mark done (x)"} aria-label={p.isDone ? "Reopen" : "Mark done"}
          onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); p.onToggle?.(card); }}
        >{p.isDone ? <IconUndo /> : <IconCheck />}</button>
      )}
      <div>
        <div className="card-title">{card.title}</div>
        {!p.overlay && <AskBlock card={card} compact />}
        {/* A writer can read an agent's work order and not change it. Said here, the way a question says who it's waiting on. */}
        {p.held && !p.overlay && <p className="card-held">{boardOwner ?? "The owner"}'s agent card. Read only.</p>}
        {/* What the agent last said it's doing, so nobody opens the card to find out. An open question says it better, and a done card is done. */}
        {/* Right after you answer, the old STATUS still says it's waiting on you, so the face says what you answered until the agent writes a new one (faceLine). */}
        {status && <div className="card-status" title={status.kind === "status" ? `STATUS: ${statusLine(card.notes) ?? status.text}` : `${boardOwner ? `${boardOwner}'s` : "Your"} answer. The agent hasn't written a new STATUS line yet.`}>{status.text}</div>}
        <div className="card-meta">
          {card.tags?.map((t) => (
            <button
              key={t} className={`chip tag${p.tagFilter === t ? " active" : ""}`} tabIndex={-1}
              title={p.tagFilter === t ? "Show every card" : `Show only #${t}`}
              onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); p.onTag?.(t); }}
            >#{t}</button>
          ))}
          <NoAgentChip card={card} />
          {card.due && <DueChip due={card.due} done={p.isDone} />}
          {card.notes && <span className="chip" title={card.notes}><IconNotes />notes</span>}
          {!!card.attachments?.length && (
            <span className="chip" title={card.attachments.map((a) => a.name).join("\n")}><IconClip />{card.attachments.length}</span>
          )}
        </div>
        {/* Who made the last change, on a shared board, when it wasn't you (member.tsx). */}
        {!p.overlay && <ByFace card={card} />}
      </div>
    </div>
  );
}

export function localToday(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function DueChip({ due, done }: { due: string; done: boolean }) {
  const today = localToday();
  let label: string;
  if (due === today) label = "Today";
  else if (due === localToday(1)) label = "Tomorrow";
  else if (due === localToday(-1)) label = "Yesterday";
  else label = new Date(`${due}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const cls = done ? "" : due < today ? " overdue" : due === today ? " today" : "";
  return <span className={`chip${cls}`}><IconCalendar />{label}</span>;
}

/** One card per line. A pasted list often comes with bullets, numbers, or checkboxes in front; those come off. */
export const quickAddLines = (text: string) =>
  text.split("\n").map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)]|\[[ x]\])\s*/i, "").trim()).filter(Boolean);

function QuickAdd({ lane, open, setOpen, add, tagHint, frozen }: { lane: Lane; open: boolean; setOpen(o: boolean): void; add(lines: string[]): Promise<AddResult>; tagHint: string; frozen?: string | null }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // What happened to the lines still in the box: "41 added, 19 left. …"
  const [note, setNote] = useState("");
  // The box exactly as the server left it: the lines it just turned down. While it still reads
  // that way the button says "Try again", not "Add 3 cards" for three lines that were refused.
  const [refused, setRefused] = useState<string | null>(null);
  // The refused lines that trying again can't help (one of the owner's tags, a look-alike, a
  // blank title): each has to be edited or taken out. While any is still in the box as it
  // was, the button says so and stays off, instead of offering a retry that can't work.
  const [mustFix, setMustFix] = useState<string[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (open && !frozen) ref.current?.focus(); }, [open, frozen]);
  // CSS `field-sizing: content` grows the box to fit its lines, wrapped ones included. Where it's
  // missing (Firefox), size it by hand; min-height and max-height in the stylesheet still clamp it.
  useLayoutEffect(() => {
    const el = ref.current;
    // `CSS` in this file is dnd-kit's helper, so the browser's is asked for by its full name.
    if (!el || window.CSS.supports("field-sizing", "content")) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [text, open, busy]);
  // The board keeps the same text, so a member who's removed outright finds it on their own board (Unsaved.tsx).
  useDraft(`quick-add:${lane.id}`, text.trim() ? { where: `"Add a card" in ${lane.name}`, lines: text } : null);

  async function submit() {
    // Pasting a list adds one card per line, all in one change.
    const lines = quickAddLines(text);
    if (!lines.length || busy || lines.some((l) => mustFix.includes(l))) return;
    setBusy(true);
    setNote("");
    // The box keeps what was typed until the server has answered, and afterwards it keeps
    // every line that didn't become a card, so nothing has to be pasted twice.
    let r: AddResult;
    try { r = await add(lines); } catch (e) { r = { added: 0, left: lines, why: e instanceof Error ? e.message : null }; }
    setBusy(false);
    setText(r.left.join("\n"));
    setRefused(r.left.length ? r.left.join("\n") : null);
    setMustFix(r.fix ?? []);
    if (r.left.length) {
      const why = r.why ?? "That didn't go through. Try again.";
      setNote(lines.length === 1 ? `Not added. ${why}` : `${r.added} added, ${r.left.length} left. ${why}`);
    }
    // Back to the top of what's left: with the caret at the end, the first lines scrolled out of the box.
    setTimeout(() => { const el = ref.current; if (!el) return; el.focus(); el.setSelectionRange(0, 0); el.scrollTop = 0; }, 0);
  }

  // The board turned view only. Typed text stays, read only, until it's dismissed; with none there's nothing to show.
  if (frozen) {
    if (!text.trim()) return null;
    return (
      <div className="quick-add frozen">
        <Unsaved draft={{ lines: text }} why={`${frozen} ${quickAddLines(text).length === 1 ? "This card wasn't" : "These cards weren't"} added.`} after="Dismiss throws it away." />
        <div className="row"><button className="btn" onClick={() => { setText(""); setNote(""); setRefused(null); setMustFix([]); setOpen(false); }}>Dismiss</button></div>
      </div>
    );
  }

  const now = quickAddLines(text);
  const count = now.length;
  const again = refused !== null && text === refused;
  /** How many lines in the box are still exactly a line that has to be edited first. */
  const toFix = now.filter((l) => mustFix.includes(l)).length;
  const label = busy ? "Adding…"
    : toFix ? (count === 1 ? "Fix this to add it" : toFix === count ? `Fix these ${count} to add them` : `Fix ${toFix} of these ${count} to add them`)
    : again ? (count > 1 ? `Try these ${count} again` : "Try again")
    : count > 1 ? `Add ${count} cards` : "Add card";

  if (!open) {
    return (
      <div className="quick-add">
        <button className="btn ghost" onClick={() => setOpen(true)}><IconPlus />Add a card</button>
      </div>
    );
  }
  return (
    <div className="quick-add">
      <textarea
        ref={ref} className="field" rows={Math.min(8, Math.max(2, text.split("\n").length))} placeholder={`What needs doing? End with ${tagHint} to tag it, or paste a list.`} value={text} aria-label={`New card in ${lane.name}`}
        readOnly={busy} aria-busy={busy} aria-describedby={note ? `quick-add-note-${lane.id}` : undefined}
        // The reasons stay up until every line they're about has been edited or taken out.
        onChange={(e) => { setText(e.target.value); if (note && !quickAddLines(e.target.value).some((l) => mustFix.includes(l))) setNote(""); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); }
          if (e.key === "Escape") { setText(""); setNote(""); setRefused(null); setMustFix([]); setOpen(false); }
        }}
        onBlur={() => { if (!text.trim() && !busy) setOpen(false); }}
      />
      {note && <p className="quick-add-note" id={`quick-add-note-${lane.id}`} role="alert">{note}</p>}
      <div className="row">
        <button className="btn primary" onMouseDown={(e) => e.preventDefault()} onClick={() => void submit()} disabled={!text.trim() || busy || toFix > 0} title={toFix ? "Edit the lines named above, or take them out, and this adds the rest" : undefined}>{label}</button>
        <button className="btn ghost" onClick={() => { setText(""); setNote(""); setRefused(null); setMustFix([]); setOpen(false); }}>Cancel</button>
        <span className="hint"><kbd>↵</kbd> add · <kbd>esc</kbd> close</span>
      </div>
    </div>
  );
}

/** A small square "+" in the margin after the last lane. The name field opens in a popover, so the board never shifts. */
function AddLane({ onAdd, full }: { onAdd(name: string): Promise<unknown>; full: boolean }) {
  const [open, setOpen] = useState(false);
  if (full) return null;
  return (
    <div className="add-lane anchor">
      <button className="btn icon" title="Add lane" aria-label="Add lane" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <IconPlus />
      </button>
      {open && (
        <Popover label="Add lane" onClose={() => setOpen(false)}>
          <div className="add-lane-form">
            <input
              className="field" autoFocus placeholder="New lane, e.g. Waiting" maxLength={40} aria-label="New lane name"
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.currentTarget.value.trim()) { void onAdd(e.currentTarget.value.trim()); setOpen(false); }
              }}
            />
            <span className="hint"><kbd>↵</kbd> add · <kbd>esc</kbd> cancel</span>
          </div>
        </Popover>
      )}
    </div>
  );
}

type PopoverProps = {
  children: React.ReactNode;
  onClose(): void;
  /** What a screen reader calls it. */
  label: string;
  /** A list of commands: role="menu", with role="menuitem" on the buttons inside. Anything else is a dialog. */
  menu?: boolean;
};

/**
 * A panel that hangs off the button before it. Opening it moves keyboard focus inside, and closing
 * it gives focus back, so a keyboard or screen reader user lands in what they just opened and
 * isn't dropped at the top of the page afterwards.
 */
export function Popover({ children, onClose, label, menu }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => { if (!ref.current?.parentElement?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", down); document.removeEventListener("keydown", key); };
  }, [onClose]);

  // A layout effect, so its cleanup runs while the panel is still in the page and can tell
  // whether focus was inside it.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const at = document.activeElement;
    const opener = at instanceof HTMLElement && at !== document.body ? at : null;
    const button = el.parentElement?.querySelector<HTMLElement>(":scope > [aria-expanded]") ?? null;
    // A field with autoFocus already has it. Otherwise: a menu's first item, the option that's
    // already picked (the theme list previews whatever takes focus), or the panel itself, so a
    // long list doesn't scroll to its first link.
    if (!el.contains(at)) {
      const first = menu
        ? el.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')
        : el.querySelector<HTMLElement>('[aria-checked="true"]');
      (first ?? el).focus();
    }
    return () => {
      // Focus that has already moved somewhere else on purpose stays there.
      const now = document.activeElement;
      if (now && now !== document.body && !el.contains(now)) return;
      // Back to whatever had focus when it opened, or the button it hangs off. The opener can be
      // gone or hidden by now (the Theme button on a phone), and focus() on it does nothing then.
      for (const target of [opener, button]) {
        if (!target?.isConnected) continue;
        target.focus();
        if (document.activeElement === target) return;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function onKeyDown(e: React.KeyboardEvent) {
    if (!menu) return;
    // Tab leaves a menu, the way it does in a native one; focus goes back to the button first.
    if (e.key === "Tab") { onClose(); return; }
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (!step && e.key !== "Home" && e.key !== "End") return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (i + step + items.length) % items.length;
    items[next].focus();
  }

  return (
    <div className="popover" ref={ref} role={menu ? "menu" : "dialog"} aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}
