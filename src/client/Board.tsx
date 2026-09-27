import {
  closestCorners, DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor,
  useDroppable, useSensor, useSensors, type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useRef, useState } from "react";
import { laneCards, type Board, type Card, type Lane } from "../shared";
import { IconCalendar, IconCheck, IconClip, IconDots, IconNotes, IconPlus, IconUndo } from "./icons";

export type Actions = {
  addCard(laneId: string, title: string, top?: boolean): Promise<unknown>;
  moveCard(id: string, laneId: string, index: number): Promise<unknown>;
  addLane(name: string): Promise<unknown>;
  renameLane(id: string, name: string): Promise<unknown>;
  deleteLane(id: string): Promise<unknown>;
  moveLane(id: string, index: number): Promise<unknown>;
  clearLane(id: string): Promise<unknown>;
};

type Props = {
  board: Board;
  actions: Actions;
  flash: Set<string>;
  quickAddLane: string | null;
  setQuickAddLane(id: string | null): void;
  onOpen(card: Card): void;
  onOptimistic(board: Board): void;
  onDragging(active: boolean): void;
  toast(text: string, undo?: boolean): void;
};

const LANE_PREFIX = "lane:";

export function BoardView(p: Props) {
  const { board } = p;
  const [drag, setDrag] = useState<{ id: string; cards: Card[] } | null>(null);
  const cards = drag?.cards ?? board.cards;
  const doneLane = board.lanes[board.lanes.length - 1]?.id;

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
    setDrag({ id: String(e.active.id), cards: board.cards });
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
    const index = laneCards({ ...board, cards: next }, lane).findIndex((c) => c.id === id);
    const before = board.cards.find((c) => c.id === id)!;
    const beforeIndex = laneCards(board, before.laneId).findIndex((c) => c.id === id);
    if (before.laneId === lane && beforeIndex === index) return;
    p.onOptimistic({ ...board, cards: next });
    void p.actions.moveCard(id, lane, index);
  }

  /** Done means "in the last lane": send the card there, or back to the top of the first lane. */
  function toggleDone(card: Card, fromKeyboard = false) {
    const target = card.laneId === doneLane ? board.lanes[0].id : doneLane;
    if (!target || target === card.laneId) return;
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
      sensors={sensors} collisionDetection={closestCorners}
      onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}
      onDragCancel={() => { setDrag(null); p.onDragging(false); }}
    >
      <div className="board">
        {board.lanes.map((lane, i) => (
          <LaneView
            key={lane.id} lane={lane} index={i} lanes={board.lanes}
            cards={cards.filter((c) => c.laneId === lane.id)}
            isDone={lane.id === doneLane && board.lanes.length > 1}
            highlight={!!active && active.laneId === lane.id}
            {...p} onToggle={toggleDone}
          />
        ))}
        <AddLane onAdd={(name) => p.actions.addLane(name)} full={board.lanes.length >= 8} />
      </div>
      <DragOverlay dropAnimation={{ duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" }}>
        {active && <CardFace card={active} isDone={active.laneId === doneLane} overlay />}
      </DragOverlay>
    </DndContext>
  );
}

function LaneView(props: Props & {
  lane: Lane; index: number; lanes: Lane[]; cards: Card[]; isDone: boolean; highlight: boolean; onToggle(c: Card): void;
}) {
  const { lane, cards, actions } = props;
  const { setNodeRef } = useDroppable({ id: LANE_PREFIX + lane.id });
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState(false);
  const adding = props.quickAddLane === lane.id;

  function commitRename(value: string) {
    if (!renaming) return;
    const v = value.trim();
    if (v && v !== lane.name) void actions.renameLane(lane.id, v);
    setRenaming(false);
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
        {renaming ? (
          <input
            className="lane-name" autoFocus defaultValue={lane.name} maxLength={40} aria-label="Lane name"
            onBlur={(e) => commitRename(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commitRename(e.currentTarget.value); if (e.key === "Escape") setRenaming(false); }}
          />
        ) : (
          <button className="lane-name" title="Rename" onClick={() => setRenaming(true)}>{lane.name}</button>
        )}
        <span className="lane-count">{cards.length}</span>
        <span className="spacer" />
        <button className="btn ghost icon" title={`Add to ${lane.name}`} onClick={() => props.setQuickAddLane(lane.id)}><IconPlus /></button>
        <div className="anchor">
          <button className="btn ghost icon" title="Lane options" aria-expanded={menu} onClick={() => setMenu((m) => !m)}><IconDots /></button>
          {menu && (
            <Popover onClose={() => setMenu(false)}>
              <div className="menu">
                <button onClick={() => { setMenu(false); setRenaming(true); }}>Rename</button>
                {props.index > 0 && <button onClick={() => { setMenu(false); void actions.moveLane(lane.id, props.index - 1); }}>Move left</button>}
                {props.index < props.lanes.length - 1 && <button onClick={() => { setMenu(false); void actions.moveLane(lane.id, props.index + 1); }}>Move right</button>}
                {cards.length > 0 && (
                  <button className="danger" onClick={() => { setMenu(false); void actions.clearLane(lane.id).then(() => props.toast(`Cleared ${cards.length} from ${lane.name}`, true)); }}>
                    {props.isDone ? "Clear finished cards" : "Clear all cards"}
                  </button>
                )}
                {props.lanes.length > 1 && (
                  <button className="danger" onClick={() => { setMenu(false); void actions.deleteLane(lane.id).then(() => props.toast(`Deleted lane ${lane.name}`, true)); }}>Delete lane</button>
                )}
              </div>
            </Popover>
          )}
        </div>
      </header>

      <SortableContext id={lane.id} items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div className="cards" ref={setNodeRef}>
          {cards.map((c) => (
            <SortableCard key={c.id} card={c} isDone={props.isDone} flash={props.flash.has(c.id)} onOpen={props.onOpen} onToggle={props.onToggle} canToggle={props.lanes.length > 1} />
          ))}
          {cards.length === 0 && !adding && (
            <div className="lane-empty">{props.index === 0 ? "Nothing here yet. Add a card, or ask the assistant." : "Drag cards here"}</div>
          )}
        </div>
      </SortableContext>

      <QuickAdd lane={lane} open={adding} setOpen={(o) => props.setQuickAddLane(o ? lane.id : null)} add={(t) => actions.addCard(lane.id, t)} />
    </section>
  );
}

function SortableCard(p: { card: Card; isDone: boolean; flash: boolean; canToggle: boolean; onOpen(c: Card): void; onToggle(c: Card, fromKeyboard?: boolean): void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: p.card.id });
  return (
    <div
      ref={setNodeRef} {...attributes} {...listeners}
      style={{ transform: CSS.Translate.toString(transform), transition, viewTransitionName: isDragging ? undefined : `card-${p.card.id}` }}
      className={isDragging ? "dragging" : undefined}
      data-card-id={p.card.id}
      aria-roledescription={`card. Space to pick up, Enter to edit, X to mark ${p.isDone ? "not done" : "done"}`}
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

function CardFace(p: { card: Card; isDone: boolean; flash?: boolean; overlay?: boolean; dragging?: boolean; onToggle?(c: Card): void }) {
  const { card } = p;
  const cls = ["card", p.isDone && "is-done", p.flash && "flash", p.overlay && "overlay", p.dragging && "dragging"].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      {/* Shown on hover and keyboard focus only; the lane already says whether a card is done. */}
      {p.onToggle && !p.overlay && (
        <button
          className="done-btn" tabIndex={-1}
          title={p.isDone ? "Reopen: move back to the first lane (x)" : "Mark done (x)"} aria-label={p.isDone ? "Reopen" : "Mark done"}
          onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); p.onToggle?.(card); }}
        >{p.isDone ? <IconUndo /> : <IconCheck />}</button>
      )}
      <div>
        <div className="card-title">{card.title}</div>
        <div className="card-meta">
          {card.due && <DueChip due={card.due} done={p.isDone} />}
          {card.notes && <span className="chip" title={card.notes}><IconNotes />notes</span>}
          {!!card.attachments?.length && (
            <span className="chip" title={card.attachments.map((a) => a.name).join("\n")}><IconClip />{card.attachments.length}</span>
          )}
        </div>
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

function QuickAdd({ lane, open, setOpen, add }: { lane: Lane; open: boolean; setOpen(o: boolean): void; add(t: string): Promise<unknown> }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (open) ref.current?.focus(); }, [open]);

  async function submit() {
    // Pasting a list adds one card per line.
    const lines = text.split("\n").map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)]|\[[ x]\])\s*/i, "").trim()).filter(Boolean);
    setText("");
    for (const l of lines) await add(l);
    ref.current?.focus();
  }

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
        ref={ref} className="field" rows={2} placeholder={`What needs doing? (paste a list to add several)`} value={text} aria-label={`New card in ${lane.name}`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submit(); }
          if (e.key === "Escape") { setText(""); setOpen(false); }
        }}
        onBlur={() => { if (!text.trim()) setOpen(false); }}
      />
      <div className="row">
        <button className="btn primary" onMouseDown={(e) => e.preventDefault()} onClick={() => void submit()} disabled={!text.trim()}>Add card</button>
        <button className="btn ghost" onClick={() => { setText(""); setOpen(false); }}>Cancel</button>
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
      <button className="btn icon" title="Add lane" aria-label="Add lane" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <IconPlus />
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)}>
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

export function Popover({ children, onClose }: { children: React.ReactNode; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => { if (!ref.current?.parentElement?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", down); document.removeEventListener("keydown", key); };
  }, [onClose]);
  return <div className="popover" ref={ref}>{children}</div>;
}
