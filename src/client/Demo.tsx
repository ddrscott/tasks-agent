// The demo board at /tasks/demo: the real board UI on a made-up board that lives in this tab.
// Nobody is signed in, so there's no Durable Object to talk to. The board is plain React state,
// changed through the same pure functions the server uses (src/shared.ts), with undo and redo
// kept in memory. No WebSocket opens and nothing is written to the server; a reload starts over.
//
// One pretend agent follows a short script (demoData.ts): answer its question and a couple of
// seconds later it goes back to working, updates the card's status line, moves the card to Done,
// then picks up the next card and asks again.
//
// Undo and Redo walk the visitor's own changes only. The agent's steps never go on the stack:
// each one is applied to the board on screen and to every board the stack remembers, so undoing
// "Add card" takes the card back out and leaves what the agent did since. How far the agent has
// got with each card (`World.at`) is saved with each remembered board, so the two can't disagree.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import * as ops from "../shared";
import type { Board, Card } from "../shared";
import { BASE } from "./base";
import { AskContext, AsksButton, type AnswerFn } from "./Ask";
import { BoardView, DESTRUCTIVE_TOAST_MS, localToday, Popover, type Actions } from "./Board";
import { CardEditor } from "./CardEditor";
import { allChecked, CLOSED_BY_YOU, demoPresence, PLOT, seedBoard, withStatus, type Beat, type Scene } from "./demoData";
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

/**
 * How far the scripted agent has got with a card of its script. No entry means it hasn't touched
 * it. "done" is a card it finished; "left" is one it gave up, because the visitor closed it first.
 */
type Stage = "picked" | "asked" | "working" | "done" | "left";
/** A board plus the agent's progress on it. Undo and redo swap the pair, never one half. */
type World = { board: Board; at: Record<string, Stage> };
type Entry = { label: string; world: World };

/** What the scripted agent does next, and how long it takes to get around to it. */
type Step = "pickup" | "ask" | "ack" | "finish" | "yield";
const STEP_MS: Record<Step, number> = { pickup: 5000, ask: 6000, ack: 2500, finish: 8000, yield: 1500 };
/** The card the agent is on and its next step. `step` is null while it waits on an answer. */
type Spot = { beat: Beat; card: Card; step: Step | null };

/** The last lane is Done, when there's more than one. */
const doneLaneOf = (b: Board) => (b.lanes.length > 1 ? b.lanes[b.lanes.length - 1].id : null);

/** Where the agent is, worked out from one world and nothing else. */
function whereIsIt(w: World): Spot | null {
  const done = doneLaneOf(w.board);
  for (const beat of PLOT) {
    const card = w.board.cards.find((c) => c.id === beat.cardId);
    const stage = w.at[beat.cardId];
    if (!card || stage === "done" || stage === "left") continue;
    const closed = card.laneId === done;
    if (!stage) {
      if (closed) continue; // the visitor finished it first
      return { beat, card, step: "pickup" };
    }
    // With an answer in hand it finishes the job wherever the card is.
    if (stage === "working") return { beat, card, step: "finish" };
    if (stage === "asked" && !card.ask) return { beat, card, step: "ack" };
    // The visitor moved its card to Done before it had an answer, so it takes its question back.
    if (closed) return { beat, card, step: "yield" };
    return { beat, card, step: stage === "picked" ? "ask" : null };
  }
  return null;
}

const short = (s: string, max = 80) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** One step of the script, as a pure change to a world. Throws when the card can't take it. */
function advance(w: World, { beat, card, step }: Spot): World {
  const b = w.board;
  const id = card.id;
  const to = (stage: Stage, board: Board): World => ({ board, at: { ...w.at, [id]: stage } });
  const status = (x: Board, line: string) => ops.updateCard(x, id, { notes: withStatus(x.cards.find((c) => c.id === id)!.notes, line) });
  // No answer means the visitor took the question off the card, so the agent goes with its own pick.
  const went = short(card.answer?.answer ?? beat.ask.options[beat.ask.recommended ?? 0]);
  if (step === "pickup") {
    const doing = card.laneId === b.lanes[0].id && b.lanes.length > 2 ? b.lanes[1].id : card.laneId;
    return to("picked", status(doing === card.laneId ? b : ops.moveCard(b, id, doing), beat.pickup));
  }
  if (step === "ask") return to("asked", ops.askCard(b, id, beat.ask));
  if (step === "ack") return to("working", status(b, beat.working(card.answer ? `got your answer ("${went}")` : `no answer, so I'm going with "${went}"`)));
  if (step === "finish") {
    const done = doneLaneOf(b);
    const said = ops.updateCard(b, id, { notes: allChecked(withStatus(card.notes, beat.done(went))) });
    return to("done", done && card.laneId !== done ? ops.moveCard(said, id, done) : said);
  }
  // Taking #needs-ceo off a card takes its question off too (updateCard).
  return to("left", ops.updateCard(b, id, { notes: withStatus(card.notes, CLOSED_BY_YOU), tags: (card.tags ?? []).filter((t) => t !== ops.NEEDS_CEO_TAG) }));
}

function DemoBoard({ signedIn, onHome, onConnect, onReset }: Props & { onReset(): void }) {
  const [startedAt] = useState(() => Date.now());
  // `saved` is the board as it stands, with how far the agent has got on it; `board` is what's
  // drawn, which runs ahead of it during a drag.
  const saved = useRef<World>(null as unknown as World);
  // The seed has the first card's question already open.
  if (!saved.current) saved.current = { board: seedBoard(readCachedTheme()), at: { [PLOT[0].cardId]: "asked" } };
  const [board, setBoard] = useState<Board>(saved.current.board);
  const undos = useRef<Entry[]>([]);
  const redos = useRef<Entry[]>([]);
  const [stack, setStack] = useState<{ undo: string | null; redo: string | null }>({ undo: null, redo: null });

  // Each card the agent has changed, with the time on the change. A card dialog that's open when
  // the agent changes its card is redrawn from the new card: it holds its own copy of the notes,
  // tags, and lane, and saving a stale copy would put the agent's card back where it was.
  const byAgent = useRef(new Set<string>());

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
  const newest = useRef<Board>(saved.current.board);

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

  /** Every change the visitor makes goes through here: run the pure function, remember the world before it for Undo. */
  const commit = useCallback((label: string, fn: (b: Board) => Board) => {
    const before = saved.current;
    const after = { board: fn(before.board), at: before.at };
    undos.current = [...undos.current.slice(1 - HISTORY_LIMIT), { label, world: before }];
    redos.current = [];
    saved.current = after;
    show(after.board, before.board);
  }, [show]);

  /**
   * The agent's changes go through here instead. They aren't the visitor's to undo, so the step
   * is also made on every remembered world where the agent was at the same point. A world where
   * it wasn't (from before the visitor answered, say) is left as it was, still waiting.
   */
  const agentStep = useCallback((spot: Spot) => {
    const before = saved.current;
    const id = spot.card.id;
    let after: World;
    // The card changed under it in some way the script can't follow, so it leaves the card alone.
    try { after = advance(before, spot); } catch { after = { board: before.board, at: { ...before.at, [id]: "left" } }; }
    const also = (e: Entry): Entry => {
      const there = whereIsIt(e.world);
      if (!there || there.card.id !== id || there.step !== spot.step) return e;
      try { return { label: e.label, world: advance(e.world, there) }; } catch { return e; }
    };
    undos.current = undos.current.map(also);
    redos.current = redos.current.map(also);
    saved.current = after;
    const stamp = after.board.cards.find((c) => c.id === id)?.updatedAt;
    if (stamp) byAgent.current.add(`${id}:${stamp}`);
    show(after.board, before.board);
    // The agent's changes light the card up, the same as on a real board.
    const was = new Map(before.board.cards.map((c) => [c.id, c]));
    const changed = after.board.cards.filter((c) => { const b = was.get(c.id); return !b || b.updatedAt !== c.updatedAt || b.laneId !== c.laneId; });
    setFlash(new Set(changed.map((c) => c.id)));
    setTimeout(() => setFlash(new Set()), 1700);
  }, [show]);

  /** A board action for the UI: the same promise shape the agent's stub gives, so a thrown error is a rejection. */
  const act = useCallback(async (label: string, fn: (b: Board) => Board) => { commit(label, fn); }, [commit]);

  const say = useCallback((text: string, undo = false, ms?: number) => setToast({ text, action: undo ? "undo" : null, key: Date.now(), ms }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.ms ?? 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // Undo and redo swap whole worlds, keeping the theme, which isn't undoable.
  const swap = useCallback((from: typeof undos, to: typeof undos) => {
    const top = from.current[from.current.length - 1];
    if (!top) return null;
    from.current = from.current.slice(0, -1);
    const before = saved.current;
    to.current = [...to.current, { label: top.label, world: before }];
    saved.current = { board: { ...top.world.board, theme: before.board.theme }, at: top.world.at };
    show(saved.current.board, before.board);
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
    addCard: (laneId, title, top) => act("Add card", (b) => ops.addCard(b, { title, laneId, top }).board),
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
    const ask = saved.current.board.cards.find((c) => c.id === id)?.ask;
    const said = input.text?.trim() || (input.choice !== undefined ? ask?.options[input.choice] : "") || "";
    act("Answer question", (b) => ops.answerAsk(b, id, input))
      .then(() => say(`Answered: ${said.length > 60 ? `${said.slice(0, 60)}…` : said}`, true))
      .catch((e: Error) => say(e.message));
  }, [act, say]);

  // The scripted agent. Where it is comes from the world as it stands, so undoing an answer puts
  // it back to waiting, and a card the visitor finishes or deletes is skipped.
  const spot = whereIsIt(saved.current);
  const spotKey = spot ? `${spot.card.id}:${spot.step}` : "";
  useEffect(() => {
    const step = spot?.step;
    if (!spot || !step) return;
    const id = spot.card.id;
    const timer = setTimeout(() => {
      const now = whereIsIt(saved.current);
      if (now && now.card.id === id && now.step === step) agentStep(now);
    }, STEP_MS[step]);
    return () => clearTimeout(timer);
  }, [spotKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // A phone shows one lane at a time, and the real board opens on the first. Here the story is
  // the open question, so the demo opens on the lane that holds it.
  useLayoutEffect(() => {
    const asked = saved.current.board.cards.find((c) => c.ask);
    const boardEl = document.querySelector<HTMLElement>(".board");
    const lane = asked && boardEl?.querySelector<HTMLElement>(`:scope > [data-lane-id="${asked.laneId}"]`);
    if (!boardEl || !lane || !matchMedia("(max-width: 900px)").matches) return;
    const pad = parseFloat(getComputedStyle(boardEl).scrollPaddingLeft) || 0;
    boardEl.scrollLeft += lane.getBoundingClientRect().left - boardEl.getBoundingClientRect().left - pad;
  }, []);

  // Sessions: time moves along so "4s ago" stays true, and the lead session follows the script.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 10_000);
    return () => clearInterval(t);
  }, []);
  // The lead session says needs input exactly while its card has a question open: the answer
  // that closes the question is the same change that puts the session back to working.
  const scene: Scene = !spot ? { at: "idle" }
    : spot.step === "pickup" ? { at: "between" }
    : { at: spot.card.ask ? "waiting" : spot.step === "ack" ? "heard" : spot.step === "finish" ? "working" : "reading", beat: spot.beat, card: spot.card };
  // The script ran out. `looped` is whether the visitor saw it through: a question answered and the card finished.
  const over = !spot;
  const looped = Object.values(saved.current.at).includes("done");
  const doneLane = board.lanes[board.lanes.length - 1]?.id;
  const seeded = demoPresence(scene, Date.now(), startedAt);
  // A card that's finished or gone isn't being worked on. The lead's claim follows the script, which already knows.
  const live = new Set(board.cards.filter((c) => c.laneId !== doneLane || board.lanes.length === 1).map((c) => c.id));
  const presence = { ...seeded, claims: seeded.claims.filter((c) => c.cardId === spot?.card.id || live.has(c.cardId)) };

  // Keyboard: n new card, t theme, / assistant, ⌘Z undo, ⇧⌘Z or Ctrl+Y redo, ⌘K search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.closest("input, textarea, select, [contenteditable]") || document.querySelector("dialog[open]");
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey && !typing) { e.preventDefault(); undo(); return; }
      const isRedo = (e.metaKey || e.ctrlKey) && ((e.key.toLowerCase() === "z" && e.shiftKey) || (e.ctrlKey && e.key.toLowerCase() === "y"));
      if (isRedo && !typing) { e.preventDefault(); redo(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); searchInput.current?.focus(); searchInput.current?.select(); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "n" && saved.current.board.lanes[0]) { e.preventDefault(); setQuickAddLane(saved.current.board.lanes[0].id); }
      if (e.key === "t") { e.preventDefault(); setThemeOpen((o) => !o); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [undo, redo]);

  const pickTheme = (theme: string) => {
    saved.current = { board: { ...saved.current.board, theme }, at: saved.current.at };
    setBoard((b) => ({ ...b, theme }));
  };
  const search = useCallback(async (query: string) => localSearch(saved.current.board, query), []);
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
    <div className="app demo">
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

        <aside className={`demo-strip${over ? " over" : ""}`} aria-label="About this demo">
          <h2 className="h">DEMO_BOARD</h2>
          {/* When the script runs out the strip says so, instead of the board just going quiet. */}
          <p aria-live="polite">
            {!over ? (
              <>
                <span className="demo-more">This board lives in your browser tab. The agents on it are scripted, nothing is saved, and a reload starts it over.</span>
                <span className="demo-short">A demo in your browser. Nothing is saved.</span>
              </>
            ) : looped ? (
              <>
                <span className="demo-more">That's the loop: the agent asks, you answer, it finishes the card. {signedIn ? "Connect an agent to run it on your own board." : "Sign up to run it with your own agent."}</span>
                <span className="demo-short">That's the loop. {signedIn ? "Connect an agent to run it for real." : "Sign up to run it with your own agent."}</span>
              </>
            ) : (
              <>
                <span className="demo-more">The scripted agent is out of cards, so that's all it does here. Start over to watch it ask a question and finish the card.</span>
                <span className="demo-short">The scripted agent is out of cards. Start over to watch it work.</span>
              </>
            )}
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
          key={byAgent.current.has(`${editingCard.id}:${editingCard.updatedAt}`) ? `${editingCard.id}:${editingCard.updatedAt}` : editingCard.id} card={editingCard} lanes={board.lanes} knownTags={knownTags} vault={null} filesNote={FILES_NOTE}
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
