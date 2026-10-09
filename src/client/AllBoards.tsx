// All my tasks: every board you can reach, on one screen (// ALL_BOARDS in the README). The
// page opens a socket per board (your first, the rest of yours, and the ones shared with you),
// merges their cards into virtual lanes by role (To do, Doing, Done, then any other lane by
// its name), and draws them with the same BoardView the board page uses, in writer mode: cards
// move and open, lanes stay as each board has them. Every change goes to the socket of the
// board the card is on. A board chip on each card says which. An encrypted board can't be
// merged (its cards are ciphertext here), so it's counted and left out.

import { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";
import type { TodoAgent } from "../agent";
import { doneLaneId, laneRoles, roleOf, todoLaneId, type LaneRole } from "../lanes";
import { plainError, plainText } from "../member-rules";
import { clean, splitTitleTags, tidyTags, type Board, type Card, type Lane } from "../shared";
import { BoardView, DESTRUCTIVE_TOAST_MS, type Actions } from "./Board";
import { BoardSwitcher } from "./BoardSwitcher";
import { CardEditor } from "./CardEditor";
import { Footer } from "./Footer";
import type { Boards, Mode } from "./member";
import { useTitle } from "./title";

/** A label for a card face, when the face is on a screen that mixes boards (CardFace reads it). */
export const CardChipContext = createContext<((card: Card) => string | null) | null>(null);

type Reach = { id: string; name: string; first: boolean; mode: Mode; lapsed: boolean };
/** A virtual card id: the board's id, a separator no card id holds, the card's id. */
const SEP = "~";
const vid = (board: string, card: string) => `${board}${SEP}${card}`;
const split = (v: string): { board: string; card: string } | null => {
  const i = v.indexOf(SEP);
  return i < 0 ? null : { board: v.slice(0, i), card: v.slice(i + 1) };
};
/** Virtual lane ids: one per role, and one per name for lanes that have no role. */
const ROLE_LANE: Record<LaneRole, Lane> = {
  todo: { id: "v:todo", name: "To do", role: "todo" },
  doing: { id: "v:doing", name: "Doing", role: "doing" },
  done: { id: "v:done", name: "Done", role: "done" },
};
const nameLane = (name: string): Lane => ({ id: `v:name:${name.trim().toLowerCase()}`, name: name.trim() });

type Stub = ReturnType<typeof useAgent<TodoAgent, Board>>["stub"];

/** One board's socket. The hook is one per component, so each board gets a component of its own. */
function BoardSocket({ reach, onState, onStub }: { reach: Reach; onState(id: string, b: Board): void; onStub(id: string, s: Stub | null): void }) {
  const agent = useAgent<TodoAgent, Board>({
    agent: "TodoAgent",
    basePath: "tasks/agent",
    ...(reach.first ? {} : { query: { board: reach.id } }),
    onStateUpdate: (s) => onState(reach.id, s),
  });
  useEffect(() => {
    onStub(reach.id, agent.stub);
    return () => onStub(reach.id, null);
  }, [agent, reach.id, onStub]);
  return null;
}

type Props = {
  me: { id: string; email: string };
  boards: Boards | null;
  onBoards(): void;
  /** Open one board: its id, or null for the first. */
  onSwitch(board: string | null): void;
  onNew(): void;
};

export function AllBoards({ me, boards, onBoards, onSwitch, onNew }: Props) {
  useTitle("All boards");
  const [states, setStates] = useState<Record<string, Board>>({});
  const stubs = useRef(new Map<string, Stub>());
  const [toast, setToast] = useState<{ text: string; key: number; ms?: number } | null>(null);
  const [editing, setEditing] = useState<{ board: string; card: string } | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [quickAddLane, setQuickAddLane] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<Board | null>(null);

  const say = useCallback((text: string, _undo = false, ms?: number) => setToast({ text, key: Date.now(), ms }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.ms ?? 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // The boards to reach, in the order they're shown: yours first, then the ones shared with you.
  const reaches = useMemo<Reach[]>(() => {
    if (!boards) return [];
    const mine: Reach[] = [{ id: me.id, name: "My board", first: true, mode: "owner", lapsed: false }];
    for (const b of boards.mine) if (!b.archived) mine.push({ id: b.board, name: b.name, first: false, mode: "owner", lapsed: false });
    for (const b of boards.shared) mine.push({ id: b.board, name: b.name ? `${b.name} · ${b.ownerEmail}` : b.ownerEmail, first: false, mode: b.effective === "writer" ? "writer" : "viewer", lapsed: b.reason === "plan_lapsed" });
    return mine;
  }, [boards, me.id]);
  const reachOf = useCallback((id: string) => reaches.find((r) => r.id === id) ?? null, [reaches]);

  const onState = useCallback((id: string, b: Board) => { setStates((s) => ({ ...s, [id]: b })); setOptimistic(null); }, []);
  const onStub = useCallback((id: string, s: Stub | null) => { if (s) stubs.current.set(id, s); else stubs.current.delete(id); }, []);

  // The merge: virtual lanes by role, then by name; cards in board order, then each board's own order.
  const { merged, sealed, labels } = useMemo(() => {
    const lanes: Lane[] = [ROLE_LANE.todo, ROLE_LANE.doing, ROLE_LANE.done];
    const seen = new Set(lanes.map((l) => l.id));
    const cards: Card[] = [];
    const labels = new Map<string, string>();
    let sealed = 0;
    for (const r of reaches) {
      const b = states[r.id];
      if (!b) continue;
      if (b.sealed) { sealed += 1; continue; }
      for (const c of b.cards) {
        const role = roleOf(b.lanes, c.laneId);
        let lane: Lane;
        if (role) lane = ROLE_LANE[role];
        else {
          lane = nameLane(b.lanes.find((l) => l.id === c.laneId)?.name ?? "Other");
          if (!seen.has(lane.id)) { seen.add(lane.id); lanes.push(lane); }
        }
        const id = vid(r.id, c.id);
        labels.set(id, r.name);
        cards.push({ ...c, id, laneId: lane.id });
      }
    }
    const merged: Board = { lanes, cards, theme: states[me.id]?.theme ?? "auto" };
    return { merged, sealed, labels };
  }, [reaches, states, me.id]);
  const shown = optimistic ?? merged;
  const chipFor = useCallback((c: Card) => labels.get(c.id) ?? null, [labels]);

  /** The real lane on `board` that a virtual lane stands for, or null with the reason. */
  const realLane = useCallback((board: string, vlane: string): { id: string } | { why: string } => {
    const b = states[board];
    const r = reachOf(board);
    if (!b || !r) return { why: "That board isn't open right now." };
    if (vlane === ROLE_LANE.todo.id) { const id = todoLaneId(b.lanes); return id ? { id } : { why: `${r.name} has no lane for new cards.` }; }
    if (vlane === ROLE_LANE.doing.id) { const id = laneRoles(b.lanes).doing; return id ? { id } : { why: `${r.name} has no Doing lane.` }; }
    if (vlane === ROLE_LANE.done.id) { const id = doneLaneId(b.lanes); return id ? { id } : { why: `${r.name} has no Done lane.` }; }
    const name = vlane.slice("v:name:".length);
    const lane = b.lanes.find((l) => l.name.trim().toLowerCase() === name && !l.role);
    return lane ? { id: lane.id } : { why: `${r.name} has no lane called "${name}".` };
  }, [states, reachOf]);

  const refused = useCallback((e: unknown) => { say(e instanceof Error && e.message ? plainError(e.message) : "That didn't go through."); setOptimistic(null); }, [say]);

  const actions: Actions = useMemo(() => ({
    // Quick add goes to your first board, in the lane the virtual lane stands for.
    addCards: async (vlane, lines) => {
      const stub = stubs.current.get(me.id);
      const lane = realLane(me.id, vlane);
      if (!stub || "why" in lane) return { added: 0, left: lines, why: "why" in lane ? lane.why : "Your board isn't open right now.", fix: [] };
      const cards = lines.map((line) => { const { title, tags } = splitTitleTags(line); return { title: clean(plainText(title), 200), ...(tags.length ? { tags } : {}) }; });
      try {
        const r = await stub.addCards(lane.id, cards);
        if (r.ids.length) say(r.ids.length === 1 ? "Added to My board" : `Added ${r.ids.length} cards to My board`);
        const left = r.left.map((x) => lines[x.index]).filter(Boolean);
        return { added: r.ids.length, left, why: r.left[0] ? plainError(r.left[0].error) : null, fix: [] };
      } catch (e) {
        return { added: 0, left: lines, why: e instanceof Error ? plainError(e.message) : null, fix: [] };
      }
    },
    moveCard: async (v, vlane, index) => {
      const at = split(v);
      if (!at) return;
      const stub = stubs.current.get(at.board);
      const lane = realLane(at.board, vlane);
      if (!stub || "why" in lane) { say("why" in lane ? lane.why : "That board isn't open right now."); setOptimistic(null); return; }
      // The index among that board's own cards in the lane: the virtual lane lists boards in
      // order, so the cards of this board ahead of `index` are the ones ahead of it there too.
      const inLane = shown.cards.filter((c) => c.laneId === vlane && c.id !== v);
      const before = inLane.slice(0, index).filter((c) => split(c.id)?.board === at.board).length;
      return stub.moveCard(at.card, lane.id, before).catch(refused);
    },
    // Lanes are each board's own: nothing here changes them (the view is in writer mode, so nothing offers to).
    addLane: async () => say("Add lanes on a board itself."),
    renameLane: async () => say("Rename lanes on a board itself."),
    deleteLane: async () => say("Delete lanes on a board itself."),
    moveLane: async () => {},
    clearLane: async () => say("Clear a lane on a board itself."),
    setLaneManual: async () => {},
    setLaneSort: async () => say("Sort a lane on a board itself."),
    setLaneRole: async () => say("Set lane roles on a board itself."),
  }), [me.id, realLane, say, shown.cards, refused]);

  const open = editing ? states[editing.board]?.cards.find((c) => c.id === editing.card) ?? null : null;
  const openReach = editing ? reachOf(editing.board) : null;
  const openStub = editing ? stubs.current.get(editing.board) : undefined;
  const openBoard = editing ? states[editing.board] : undefined;
  const openCount = shown.cards.filter((c) => c.laneId !== ROLE_LANE.done.id).length;
  const knownTags = useMemo(() => [...new Set(shown.cards.flatMap((c) => c.tags ?? []))], [shown.cards]);

  return (
    <CardChipContext.Provider value={chipFor}>
    <div className="app">
      {reaches.map((r) => <BoardSocket key={r.id} reach={r} onState={onState} onStub={onStub} />)}
      <div className="main">
        <header className="topbar">
          <h1 className="wordmark">tasks<span>.</span></h1>
          <BoardSwitcher boards={boards} myId={me.id} access={null} own={null} all onSwitch={onSwitch} onOpen={onBoards} onNew={onNew} onAll={() => {}} />
          <span className="open-count">{openCount} open</span>
          <span className="spacer" />
        </header>
        <aside className="member-line" role="status" aria-label="All boards">
          <span className="member-line-mark" aria-hidden="true">$</span>
          <span className="member-line-text">
            <b>Every board you can reach, on one screen.</b> Cards are grouped by what their lane means: To do, Doing, Done. Move a card and it moves on its own board; a new card lands on My board.
            {sealed > 0 && ` ${sealed === 1 ? "One encrypted board isn't shown here: open it on its own." : `${sealed} encrypted boards aren't shown here: open them on their own.`}`}
          </span>
        </aside>
        <BoardView
          board={shown} actions={actions} flash={new Set()} mode="writer"
          tagFilter={tagFilter} onTag={(t) => setTagFilter((cur) => (cur === t ? null : t))}
          quickAddLane={quickAddLane} setQuickAddLane={setQuickAddLane}
          onNew={(vlane) => setQuickAddLane(vlane)}
          onOpen={(c: Card) => { const at = split(c.id); if (at) setEditing(at); }}
          onOptimistic={(b) => setOptimistic(b)}
          onDragging={() => {}}
          toast={say}
        />
        <Footer />
      </div>

      {open && openReach && openBoard && openStub && (
        <CardEditor
          key={vid(editing!.board, open.id)} card={open} lanes={openBoard.lanes} knownTags={knownTags} vault={null}
          mode={openReach.mode} board={openReach.first ? undefined : openReach.id} lapsed={openReach.lapsed}
          onSave={(patch) => {
            const p: typeof patch = {};
            if (patch.title !== undefined) p.title = clean(plainText(patch.title), 200);
            if (patch.notes !== undefined) p.notes = patch.notes ? plainText(patch.notes).slice(0, 4000) : "";
            if (patch.due !== undefined) p.due = patch.due || null;
            if (patch.tags !== undefined) p.tags = tidyTags(patch.tags);
            void openStub.updateCard(open.id, p).catch(refused);
          }}
          onMove={(laneId) => void openStub.moveCard(open.id, laneId, Number.MAX_SAFE_INTEGER).catch(refused)}
          onMoveNow={(laneId) => {
            const to = openBoard.lanes.find((l) => l.id === laneId)?.name ?? "lane";
            void openStub.moveCard(open.id, laneId, Number.MAX_SAFE_INTEGER).then(() => say(`Moved "${open.title}" to ${to}`), refused);
          }}
          onDelete={() => { const t = open.title; void openStub.deleteCard(open.id).then(() => say(`Deleted "${t}". Undo is on ${openReach.name}.`, false, DESTRUCTIVE_TOAST_MS), refused); setEditing(null); }}
          onRemoveAttachment={(id) => void openStub.removeAttachment(open.id, id).catch(refused)}
          isDone={open.laneId === doneLaneId(openBoard.lanes)}
          onToggleDone={doneLaneId(openBoard.lanes) ? () => {
            const done = doneLaneId(openBoard.lanes)!;
            const target = open.laneId === done ? todoLaneId(openBoard.lanes)! : done;
            void openStub.moveCard(open.id, target, open.laneId === done ? 0 : Number.MAX_SAFE_INTEGER).catch(refused);
            setEditing(null);
          } : undefined}
          onClose={() => setEditing(null)}
        />
      )}

      {toast && (
        <div className="toast" role="status" key={toast.key}>
          <span>{toast.text}</span>
        </div>
      )}
    </div>
    </CardChipContext.Provider>
  );
}
