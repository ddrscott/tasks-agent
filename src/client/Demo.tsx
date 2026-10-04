// The demo board at /tasks/demo: the real board UI on a made-up board that lives in this tab.
// Nobody is signed in, so there's no Durable Object to talk to. The board is plain React state,
// changed through the same pure functions the server uses (src/shared.ts), with undo and redo
// kept in memory. No WebSocket opens and nothing is written to the server; a reload starts over.
//
// One pretend agent follows a short script (demoData.ts): answer its question and a couple of
// seconds later it goes back to working, updates the card's status line, moves the card to Done,
// then picks up the next card and asks again.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import * as ops from "../shared";
import type { Board, Card } from "../shared";
import { BASE } from "./base";
import { AskContext, AsksButton, type AnswerFn } from "./Ask";
import { BoardView, DESTRUCTIVE_TOAST_MS, localToday, Popover, type Actions } from "./Board";
import { CardEditor } from "./CardEditor";
import { demoPresence, PLOT, seedBoard, withStatus, type Beat, type Scene } from "./demoData";
import { Footer } from "./Footer";
import { IconChat, IconClose, IconRedo, IconUndo } from "./icons";
import { localSearch } from "./localSearch";
import { NewCard, type NewCardInput } from "./NewCard";
import { SearchBox } from "./Search";
import { PresenceContext, SessionsButton } from "./Sessions";
import { ThemePicker } from "./ThemePicker";
import { readCachedTheme } from "./themes";
import { useTitle } from "./title";
import { fitTopbar } from "./topbarFit";

type Props = {
  /** Someone with an account is looking at the demo, so the strip offers their board instead of sign-up. */
  signedIn: boolean;
  /** To the sign-in screen, or the board for someone signed in. */
  onHome(): void;
  onConnect(hash?: string): void;
};

/** Start over swaps in a fresh board by remounting it. */
export function Demo(p: Props) {
  useTitle("Demo board");
  const [run, setRun] = useState(0);
  return <DemoBoard key={run} {...p} onReset={() => setRun((n) => n + 1)} />;
}

const HISTORY_LIMIT = 50;
const FILES_NOTE = "Files are stored with an account. Sign up to attach screenshots and logs.";

/** What the scripted agent does next, and how long it takes to get around to it. */
type Step = "pickup" | "ask" | "ack" | "finish";
const STEP_MS: Record<Step, number> = { pickup: 5000, ask: 6000, ack: 2500, finish: 8000 };
/** Which cards the agent has picked up, asked on, read the answer on, and finished. Not undoable, like a real agent's memory. */
type Memory = Record<"started" | "asked" | "acked" | "finished", Set<string>>;

/** The card the agent is on and its next step. `step` is null while it waits on an answer. */
function whereIsIt(b: Board, m: Memory): { beat: Beat; card: Card; step: Step | null } | null {
  if (b.lanes.length < 2) return null; // no Done lane to finish into
  const done = b.lanes[b.lanes.length - 1].id;
  for (const beat of PLOT) {
    const card = b.cards.find((c) => c.id === beat.cardId);
    if (!card || card.laneId === done || m.finished.has(card.id)) continue;
    const step = !m.started.has(card.id) ? "pickup" : card.ask ? null : !m.asked.has(card.id) ? "ask" : !m.acked.has(card.id) ? "ack" : "finish";
    return { beat, card, step };
  }
  return null;
}

function DemoBoard({ signedIn, onHome, onConnect, onReset }: Props & { onReset(): void }) {
  const [startedAt] = useState(() => Date.now());
  // `saved` is the board as it stands; `board` is what's drawn, which runs ahead of it during a drag.
  const saved = useRef<Board>(null as unknown as Board);
  if (!saved.current) saved.current = seedBoard(readCachedTheme());
  const [board, setBoard] = useState<Board>(saved.current);
  const undos = useRef<{ label: string; board: Board }[]>([]);
  const redos = useRef<{ label: string; board: Board }[]>([]);
  const [stack, setStack] = useState<{ undo: string | null; redo: string | null }>({ undo: null, redo: null });
  const memory = useRef<Memory>({ started: new Set([PLOT[0].cardId]), asked: new Set([PLOT[0].cardId]), acked: new Set(), finished: new Set() });

  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [quickAddLane, setQuickAddLane] = useState<string | null>(null);
  const [newCardLane, setNewCardLane] = useState<string | null>(null);
  const [themeOpen, setThemeOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [asksOpen, setAsksOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; action: "undo" | "redo" | null; key: number; ms?: number } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const dragging = useRef(false);
  const pending = useRef<Board | null>(null);
  const newest = useRef<Board>(saved.current);

  // Draw a new board, animated like the real one. During a drag it waits until the card is dropped.
  const show = useCallback((next: Board, prev: Board) => {
    setStack({ undo: undos.current[undos.current.length - 1]?.label ?? null, redo: redos.current[redos.current.length - 1]?.label ?? null });
    if (dragging.current) { pending.current = next; return; }
    newest.current = next;
    const moved = JSON.stringify({ l: prev.lanes, c: prev.cards }) !== JSON.stringify({ l: next.lanes, c: next.cards });
    const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
    if (moved && doc.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // A transition that's skipped (a newer one started, or the tab is in the background) still draws the board.
      doc.startViewTransition(() => flushSync(() => setBoard(newest.current))).ready.catch(() => {});
    } else setBoard(next);
  }, []);

  /** Every change goes through here: run the pure function, remember the board before it for Undo. */
  const commit = useCallback((label: string, fn: (b: Board) => Board, byAgent = false) => {
    const before = saved.current;
    const after = fn(before);
    undos.current = [...undos.current.slice(1 - HISTORY_LIMIT), { label, board: before }];
    redos.current = [];
    saved.current = after;
    show(after, before);
    if (byAgent) {
      // The agent's changes light the card up, the same as on a real board.
      const was = new Map(before.cards.map((c) => [c.id, c]));
      const changed = after.cards.filter((c) => { const b = was.get(c.id); return !b || b.updatedAt !== c.updatedAt || b.laneId !== c.laneId; });
      setFlash(new Set(changed.map((c) => c.id)));
      setTimeout(() => setFlash(new Set()), 1700);
    }
    return after;
  }, [show]);

  /** A board action for the UI: the same promise shape the agent's stub gives, so a thrown error is a rejection. */
  const act = useCallback(async (label: string, fn: (b: Board) => Board) => { commit(label, fn); }, [commit]);

  const say = useCallback((text: string, undo = false, ms?: number) => setToast({ text, action: undo ? "undo" : null, key: Date.now(), ms }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.ms ?? 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // Undo and redo swap whole boards, keeping the theme, which isn't undoable.
  const swap = useCallback((from: typeof undos, to: typeof undos) => {
    const top = from.current[from.current.length - 1];
    if (!top) return null;
    from.current = from.current.slice(0, -1);
    const before = saved.current;
    to.current = [...to.current, { label: top.label, board: before }];
    saved.current = { ...top.board, theme: before.theme };
    show(saved.current, before);
    return top.label;
  }, [show]);
  const undo = useCallback(() => {
    const label = swap(undos, redos);
    setToast({ text: label ? `Undid: ${label.toLowerCase()}` : "Nothing to undo", action: label ? "redo" : null, key: Date.now() });
  }, [swap]);
  const redo = useCallback(() => {
    const label = swap(redos, undos);
    setToast({ text: label ? `Redid: ${label.toLowerCase()}` : "Nothing to redo", action: label ? "undo" : null, key: Date.now() });
  }, [swap]);

  const actions: Actions = useMemo(() => ({
    addCard: (laneId, title, top) => act("Add card", (b) => ops.addCard(b, { ...ops.splitTitleTags(title), laneId, top }).board),
    moveCard: (id, laneId, index) => act("Move card", (b) => ops.moveCard(b, id, laneId, index)),
    addLane: (name) => act("Add lane", (b) => ops.addLane(b, name).board),
    renameLane: (id, name) => act("Rename lane", (b) => ops.renameLane(b, id, name)),
    deleteLane: (id) => act("Delete lane", (b) => ops.deleteLane(b, id)),
    moveLane: (id, index) => act("Move lane", (b) => ops.moveLane(b, id, index)),
    clearLane: (id) => act("Clear lane", (b) => ops.deleteCards(b, ops.laneCards(b, id).map((c) => c.id))),
    setLaneManual: (id, ids) => act("Manual order", (b) => ops.setLaneSort(ops.orderLane(b, id, ids), id, null)),
    setLaneSort: (id, by) => act(by ? "Sort lane" : "Manual order", (b) => ops.setLaneSort(b, id, by)),
  }), [act]);

  const addFullCard = useCallback(async (input: NewCardInput) => {
    let id = "";
    commit("Add card", (b) => {
      const r = ops.addCard(b, { title: input.title, laneId: input.laneId, notes: input.notes, due: input.due, tags: input.tags });
      id = r.card.id;
      return r.board;
    });
    return id;
  }, [commit]);

  const answerAsk: AnswerFn = useCallback((id, input) => {
    const ask = saved.current.cards.find((c) => c.id === id)?.ask;
    const said = input.text?.trim() || (input.choice !== undefined ? ask?.options[input.choice] : "") || "";
    act("Answer question", (b) => ops.answerAsk(b, id, input))
      .then(() => say(`Answered: ${said.length > 60 ? `${said.slice(0, 60)}…` : said}`, true))
      .catch((e: Error) => say(e.message));
  }, [act, say]);

  // The scripted agent. Where it is comes from the board, so undoing an answer puts it back to
  // waiting, and a card the visitor finishes or deletes is skipped.
  const spot = whereIsIt(board, memory.current);
  const spotKey = spot ? `${spot.card.id}:${spot.step}` : "";
  useEffect(() => {
    if (!spot) return;
    const id = spot.card.id;
    const m = memory.current;
    if (!spot.step) { m.acked.delete(id); return; } // a question is open again, so the next answer is news
    const timer = setTimeout(() => {
      const now = whereIsIt(saved.current, m);
      if (!now || now.card.id !== id || now.step !== spot.step) return;
      const { beat, card } = now;
      const b = saved.current;
      const answer = card.answer?.answer ?? "your call";
      const note = (line: string) => (x: Board) => ops.updateCard(x, id, { notes: withStatus(x.cards.find((c) => c.id === id)!.notes, line) });
      try {
        if (now.step === "pickup") {
          m.started.add(id);
          const doing = card.laneId === b.lanes[0].id && b.lanes.length > 2 ? b.lanes[1].id : card.laneId;
          commit("Agent picked up a card", (x) => note(beat.pickup)(ops.moveCard(x, id, doing)), true);
        } else if (now.step === "ask") {
          m.asked.add(id);
          commit("Agent asked a question", (x) => ops.askCard(x, id, beat.ask), true);
        } else if (now.step === "ack") {
          m.acked.add(id);
          commit("Agent updated a card", note(beat.working(answer)), true);
        } else {
          m.finished.add(id);
          commit("Agent finished a card", (x) => ops.moveCard(note(beat.done(answer))(x), id, x.lanes[x.lanes.length - 1].id), true);
        }
      } catch {
        m.finished.add(id); // the card changed under it in some way the script can't follow; leave it alone
      }
    }, STEP_MS[spot.step]);
    return () => clearTimeout(timer);
  }, [spotKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sessions: time moves along so "4s ago" stays true, and the lead session follows the script.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 10_000);
    return () => clearInterval(t);
  }, []);
  const scene: Scene = !spot ? { at: memory.current.finished.size ? "idle" : "between" }
    : spot.step === "pickup" ? { at: "between" }
    : { at: spot.step === "ask" ? "reading" : spot.step === "finish" ? "working" : "waiting", beat: spot.beat, card: spot.card };
  const doneLane = board.lanes[board.lanes.length - 1]?.id;
  const seeded = demoPresence(scene, Date.now(), startedAt);
  // A card that's finished or gone isn't being worked on.
  const live = new Set(board.cards.filter((c) => c.laneId !== doneLane || board.lanes.length === 1).map((c) => c.id));
  const presence = { ...seeded, claims: seeded.claims.filter((c) => live.has(c.cardId)) };

  // Keyboard: n new card, t theme, ⌘Z undo, ⇧⌘Z or Ctrl+Y redo, ⌘K search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.closest("input, textarea, select, [contenteditable]") || document.querySelector("dialog[open]");
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey && !typing) { e.preventDefault(); undo(); return; }
      const isRedo = (e.metaKey || e.ctrlKey) && ((e.key.toLowerCase() === "z" && e.shiftKey) || (e.ctrlKey && e.key.toLowerCase() === "y"));
      if (isRedo && !typing) { e.preventDefault(); redo(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); searchInput.current?.focus(); searchInput.current?.select(); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "n" && saved.current.lanes[0]) { e.preventDefault(); setQuickAddLane(saved.current.lanes[0].id); }
      if (e.key === "t") { e.preventDefault(); setThemeOpen((o) => !o); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const pickTheme = (theme: string) => {
    saved.current = { ...saved.current, theme };
    setBoard((b) => ({ ...b, theme }));
  };
  const search = useCallback(async (query: string) => localSearch(saved.current, query), []);
  const knownTags = useMemo(() => ops.tagsByUse(board), [board]);

  const open = board.cards.filter((c) => c.laneId !== doneLane || board.lanes.length === 1);
  const today = localToday();
  const dueToday = open.filter((c) => c.due === today).length;
  const overdue = open.filter((c) => c.due && c.due < today).length;
  const editingCard = board.cards.find((c) => c.id === editing);
  const move = (id: string, laneId: string, index = Number.MAX_SAFE_INTEGER) => act("Move card", (b) => ops.moveCard(b, id, laneId, index));
  // Real links, so they open in a new tab; a plain click stays in the app.
  const stay = (go: () => void) => (e: React.MouseEvent) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); go(); };

  return (
    <AskContext.Provider value={answerAsk}>
    <PresenceContext.Provider value={presence}>
    <div className="app">
      <div className="main">
        <header className="topbar" ref={fitTopbar}>
          <h1 className="wordmark">tasks<span>.</span></h1>
          <div className="stats" aria-label="Summary">
            <span><b>{open.length}</b> open</span>
            {dueToday > 0 && <span className="due-today"><b>{dueToday}</b> due today</span>}
            {overdue > 0 && <span className="overdue"><b>{overdue}</b> overdue</span>}
          </div>
          {tagFilter && (
            <button className="chip tag active filter-chip" onClick={() => setTagFilter(null)} title="Show every card">
              #{tagFilter}<IconClose />
            </button>
          )}
          <span className="spacer" />
          <SearchBox search={search} onOpen={setEditing} inputRef={searchInput} />
          <div className="actions">
            <div className="btn-pair">
              <button className="btn" onClick={undo} disabled={!stack.undo} title={stack.undo ? `Undo ${stack.undo.toLowerCase()} (⌘Z)` : "Nothing to undo"} aria-label="Undo">
                <IconUndo /><span className="hide-sm label">Undo</span>
              </button>
              <button className="btn icon" onClick={redo} disabled={!stack.redo} title={stack.redo ? `Redo ${stack.redo.toLowerCase()} (⇧⌘Z)` : "Nothing to redo"} aria-label="Redo">
                <IconRedo />
              </button>
            </div>
            <AsksButton cards={board.cards} presence={presence} open={asksOpen} setOpen={setAsksOpen} onOpenCard={setEditing} />
            <SessionsButton
              presence={presence} open={sessionsOpen} setOpen={setSessionsOpen} onConnect={onConnect}
              cardTitle={(id) => board.cards.find((c) => c.id === id)?.title ?? null}
            />
            <ThemePicker current={board.theme} open={themeOpen} setOpen={setThemeOpen} onPick={pickTheme} />
            {/* The assistant runs on the server, so here it only says what it is. */}
            <div className="anchor hide-sm">
              <button className="btn" aria-haspopup="dialog" aria-expanded={assistantOpen} onClick={() => setAssistantOpen((o) => !o)} title="Assistant" aria-label="Assistant">
                <IconChat /><span className="label">Assistant</span>
              </button>
              {assistantOpen && (
                <Popover label="Assistant" onClose={() => setAssistantOpen(false)}>
                  <div className="demo-note">
                    <h2 className="h">ASSISTANT</h2>
                    <p>A chat panel that edits the board for you: "move the infra cards to Doing", "what's due this week".</p>
                    <p>It runs on the server, so it needs an account. <a href={`${BASE}/`} onClick={stay(onHome)}>Sign up to use it</a>.</p>
                  </div>
                </Popover>
              )}
            </div>
          </div>
        </header>

        <aside className="demo-strip" aria-label="About this demo">
          <h2 className="h">DEMO_BOARD</h2>
          <p>
            <span className="demo-more">This board lives in your browser tab. The agents on it are scripted, nothing is saved, and a reload starts it over.</span>
            <span className="demo-short">A demo in your browser. Nothing is saved.</span>
          </p>
          <div className="demo-links">
            <button className="btn ghost demo-reset" onClick={onReset}>Start over</button>
            <a className="btn" href={`${BASE}/connect`} onClick={stay(() => onConnect())}>Connect an agent</a>
            <a className="btn primary" href={`${BASE}/`} onClick={stay(onHome)}>{signedIn ? "Back to your board" : "Sign up free"}</a>
          </div>
        </aside>

        <BoardView
          board={board} actions={actions} flash={flash}
          tagFilter={tagFilter} onTag={(t) => setTagFilter((cur) => (cur === t ? null : t))}
          quickAddLane={quickAddLane} setQuickAddLane={setQuickAddLane}
          onNew={setNewCardLane}
          onOpen={(c: Card) => setEditing(c.id)}
          onOptimistic={(b) => setBoard(b)}
          onDragging={(d) => {
            dragging.current = d;
            if (!d && pending.current) { const p = pending.current; pending.current = null; setBoard(p); }
          }}
          toast={say}
        />
        <Footer />
      </div>

      {newCardLane && (
        <NewCard key={newCardLane} lanes={board.lanes} laneId={newCardLane} knownTags={knownTags} vault={null} filesNote={FILES_NOTE} onAdd={addFullCard} onClose={() => setNewCardLane(null)} />
      )}
      {editingCard && (
        <CardEditor
          key={editingCard.id} card={editingCard} lanes={board.lanes} knownTags={knownTags} vault={null} filesNote={FILES_NOTE}
          onSave={(patch) => void act("Edit card", (b) => ops.updateCard(b, editingCard.id, patch)).catch((e: Error) => say(e.message))}
          onMove={(laneId) => void move(editingCard.id, laneId)}
          onMoveNow={(laneId) => {
            const to = board.lanes.find((l) => l.id === laneId)?.name ?? "lane";
            void move(editingCard.id, laneId).then(() => say(`Moved "${editingCard.title}" to ${to}`, true));
          }}
          onDelete={() => { const t = editingCard.title; void act("Delete card", (b) => ops.deleteCards(b, [editingCard.id])).then(() => say(`Deleted "${t}"`, true, DESTRUCTIVE_TOAST_MS)); }}
          isDone={editingCard.laneId === doneLane && board.lanes.length > 1}
          onToggleDone={board.lanes.length > 1 ? () => {
            const reopen = editingCard.laneId === doneLane;
            void move(editingCard.id, reopen ? board.lanes[0].id : doneLane, reopen ? 0 : undefined)
              .then(() => say(reopen ? `Reopened "${editingCard.title}"` : `Done: "${editingCard.title}"`, true));
          } : undefined}
          onRemoveAttachment={() => {}}
          onClose={() => setEditing(null)}
        />
      )}

      {toast && (
        <div className="toast" role="status" key={toast.key}>
          <span>{toast.text}</span>
          {toast.action === "undo" && <button onClick={() => { setToast(null); undo(); }}>Undo</button>}
          {toast.action === "redo" && <button onClick={() => { setToast(null); redo(); }}>Redo</button>}
        </div>
      )}
    </div>
    </PresenceContext.Provider>
    </AskContext.Provider>
  );
}
