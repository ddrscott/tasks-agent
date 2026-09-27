import { useAgent } from "agents/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { TodoAgent } from "../agent";
import type { Usage } from "../billing";
import type { Board, Card } from "../shared";
import { api, BASE } from "./base";
import { BoardView, localToday, Popover, type Actions } from "./Board";
import { CardEditor } from "./CardEditor";
import { Chat } from "./Chat";
import { Connect } from "./Connect";
import { Footer } from "./Footer";
import { Legal } from "./Legal";
import { SearchBox } from "./Search";
import { IconChat, IconRedo, IconUndo, IconUser } from "./icons";
import { Login } from "./Login";
import { applyTheme, readCachedTheme } from "./themes";
import { ThemePicker } from "./ThemePicker";

type Me = { email: string; id: string; model: string };
type Page = "board" | "connect" | "privacy" | "terms";
const PAGES: Page[] = ["connect", "privacy", "terms"];

const pageFromPath = (): Page => {
  const sub = location.pathname.replace(/\/+$/, "").slice(BASE.length + 1) as Page;
  return PAGES.includes(sub) ? sub : "board";
};

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [page, setPage] = useState<Page>(pageFromPath);

  const go = useCallback((p: Page) => {
    history.pushState(null, "", p === "board" ? `${BASE}/` : `${BASE}/${p}`);
    setPage(p);
    scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const onPop = () => setPage(pageFromPath());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const load = useCallback(async () => {
    const r = await fetch(api("/api/me"));
    setMe(r.ok ? ((await r.json()) as Me) : null);
  }, []);

  useEffect(() => {
    applyTheme(readCachedTheme());
    void load();
  }, [load]);

  // The privacy policy and terms are public; everything else needs a session.
  if (page === "privacy" || page === "terms") return <Legal page={page} onBack={() => go("board")} />;
  if (me === undefined) return <div className="splash">loading</div>;
  if (me === null) return <Login onSignedIn={load} />;
  if (page === "connect") return <Connect onBack={() => go("board")} />;
  return <Workspace me={me} onSignOut={() => setMe(null)} onConnect={() => go("connect")} />;
}

function Workspace({ me, onSignOut, onConnect }: { me: Me; onSignOut(): void; onConnect(): void }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [stack, setStack] = useState<{ undo: string | null; redo: string | null }>({ undo: null, redo: null });
  const [editing, setEditing] = useState<string | null>(null);
  const [quickAddLane, setQuickAddLane] = useState<string | null>(null);
  const [themeOpen, setThemeOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(() => {
    try { return localStorage.getItem("todo-chat") !== "closed" && innerWidth > 900; } catch { return innerWidth > 900; }
  });
  const [toast, setToast] = useState<{ text: string; action: "undo" | "redo" | null; key: number } | null>(null);

  const boardRef = useRef<Board | null>(null);
  const dragging = useRef(false);
  const pending = useRef<Board | null>(null);
  const agentBusy = useRef(false);
  const chatInput = useRef<HTMLTextAreaElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  // receive() runs before `agent` exists in this render, so it reaches the agent through a ref.
  const agentRef = useRef<{ stub: { setTheme(theme: string): Promise<unknown> } } | null>(null);
  boardRef.current = board;

  // Server state lands here. Changes animate with a view transition, unless a drag
  // is in progress; then the newest state waits until the card is dropped.
  const receive = useCallback((next: Board) => {
    if (dragging.current) { pending.current = next; return; }
    const prev = boardRef.current;
    // A new account (another sign-in email) starts on Auto. Until the user picks a theme
    // on it, keep the one this browser already uses instead of switching under them.
    const cached = readCachedTheme();
    if (!prev && !next.themeChosen && cached !== next.theme) {
      applyTheme(cached);
      void agentRef.current?.stub.setTheme(cached);
    } else {
      applyTheme(next.theme);
    }
    if (prev && agentBusy.current) {
      const before = new Map(prev.cards.map((c) => [c.id, c]));
      const changed = next.cards.filter((c) => { const b = before.get(c.id); return !b || b.updatedAt !== c.updatedAt || b.laneId !== c.laneId; });
      if (changed.length) {
        setFlash(new Set(changed.map((c) => c.id)));
        setTimeout(() => setFlash(new Set()), 1700);
      }
    }
    const layoutChanged = !prev || JSON.stringify({ l: prev.lanes, c: prev.cards }) !== JSON.stringify({ l: next.lanes, c: next.cards });
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (prev && layoutChanged && doc.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      doc.startViewTransition(() => flushSync(() => setBoard(next)));
    } else {
      setBoard(next);
    }
  }, []);

  const agent = useAgent<TodoAgent, Board>({
    agent: "TodoAgent",
    basePath: "tasks/agent", // the Worker picks your board from the session cookie
    onStateUpdate: (s) => receive(s),
  });
  agentRef.current = agent;

  // Assistant usage and plan, for the meter in the chat and the upgrade prompts.
  const [usage, setUsage] = useState<Usage | null>(null);
  const refreshUsage = useCallback(() => { agent.stub.usage().then(setUsage).catch(() => {}); }, [agent]);
  useEffect(() => { if (board) refreshUsage(); }, [!!board, refreshUsage]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back from Stripe Checkout. The webhook can land a moment after the redirect, so look twice.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const b = q.get("billing");
    if (!b) return;
    history.replaceState(null, "", location.pathname);
    if (b === "success") {
      say("Thanks for going Pro. Your higher limit is on.");
      const t = setTimeout(refreshUsage, 4000);
      return () => clearTimeout(t);
    }
  }, [refreshUsage]); // eslint-disable-line react-hooks/exhaustive-deps

  const billing = useCallback(async (kind: "checkout" | "portal") => {
    const r = await fetch(api(`/api/billing/${kind}`), { method: "POST" });
    const data = (await r.json().catch(() => ({}))) as { url?: string; error?: string };
    if (data.url) location.assign(data.url);
    else say(data.error ?? "Billing is having trouble. Try again in a minute.");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the Undo and Redo buttons' labels current.
  useEffect(() => {
    if (!board) return;
    agent.stub.undoRedo().then(setStack).catch(() => {});
  }, [board, agent]);

  const say = useCallback((text: string, undo = false) => setToast({ text, action: undo ? "undo" : null, key: Date.now() }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const redo = useCallback(async () => {
    const label = await agent.stub.redo();
    setToast({ text: label ? `Redid: ${label.toLowerCase()}` : "Nothing to redo", action: label ? "undo" : null, key: Date.now() });
  }, [agent]);

  const undo = useCallback(async () => {
    const label = await agent.stub.undo();
    // Offer Redo right where the eye already is, in case the undo was an accident.
    setToast({ text: label ? `Undid: ${label.toLowerCase()}` : "Nothing to undo", action: label ? "redo" : null, key: Date.now() });
  }, [agent, say]);

  const actions: Actions = useMemo(() => ({
    addCard: (laneId, title, top) => agent.stub.addCard(laneId, title, top),
    moveCard: (id, laneId, index) => agent.stub.moveCard(id, laneId, index),
    addLane: (name) => agent.stub.addLane(name),
    renameLane: (id, name) => agent.stub.renameLane(id, name),
    deleteLane: (id) => agent.stub.deleteLane(id),
    moveLane: (id, index) => agent.stub.moveLane(id, index),
    clearLane: (id) => agent.stub.clearLane(id),
  }), [agent]);

  const setChat = useCallback((open: boolean) => {
    setChatOpen(open);
    try { localStorage.setItem("todo-chat", open ? "open" : "closed"); } catch {}
    if (open) setTimeout(() => chatInput.current?.focus(), 50);
  }, []);

  // Keyboard: n new card, / chat, t theme, ⌘Z undo, ⇧⌘Z or Ctrl+Y redo, ⌘K search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.closest("input, textarea, select, [contenteditable]") || document.querySelector("dialog[open]");
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey && !typing) { e.preventDefault(); void undo(); return; }
      const isRedo = (e.metaKey || e.ctrlKey) && ((e.key.toLowerCase() === "z" && e.shiftKey) || (e.ctrlKey && e.key.toLowerCase() === "y"));
      if (isRedo && !typing) { e.preventDefault(); void redo(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); searchInput.current?.focus(); searchInput.current?.select(); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "n" && boardRef.current?.lanes[0]) { e.preventDefault(); setQuickAddLane(boardRef.current.lanes[0].id); }
      if (e.key === "/") { e.preventDefault(); setChat(true); }
      if (e.key === "t") { e.preventDefault(); setThemeOpen((o) => !o); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [undo, redo, setChat]);

  // Auto theme follows the OS as it changes.
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => { if (boardRef.current?.theme === "auto") applyTheme("auto"); };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const searchCards = useCallback((query: string) => agent.stub.search({ query, limit: 12 }), [agent]);

  const onBusy = useCallback((b: boolean) => {
    agentBusy.current = b;
    if (!b) refreshUsage(); // a turn just finished, so the count moved
  }, [refreshUsage]);

  if (!board) return <div className="splash">opening your board</div>;

  const doneLane = board.lanes[board.lanes.length - 1]?.id;
  const open = board.cards.filter((c) => c.laneId !== doneLane || board.lanes.length === 1);
  const today = localToday();
  const dueToday = open.filter((c) => c.due === today).length;
  const overdue = open.filter((c) => c.due && c.due < today).length;
  const editingCard = board.cards.find((c) => c.id === editing);

  async function signOut() {
    await fetch(api("/api/auth/logout"), { method: "POST" });
    onSignOut();
  }

  return (
    <div className="app">
      <div className="main">
        <header className="topbar">
          <h1 className="wordmark">tasks<span>.</span></h1>
          <div className="stats" aria-label="Summary">
            <span><b>{open.length}</b> open</span>
            {dueToday > 0 && <span className="due-today"><b>{dueToday}</b> due today</span>}
            {overdue > 0 && <span className="overdue"><b>{overdue}</b> overdue</span>}
          </div>
          <span className="spacer" />
          <SearchBox search={searchCards} onOpen={setEditing} inputRef={searchInput} />
          <div className="actions">
            <div className="btn-pair">
              <button className="btn" onClick={() => void undo()} disabled={!stack.undo} title={stack.undo ? `Undo ${stack.undo.toLowerCase()} (⌘Z)` : "Nothing to undo"}>
                <IconUndo /><span className="hide-sm">Undo</span>
              </button>
              <button className="btn icon" onClick={() => void redo()} disabled={!stack.redo} title={stack.redo ? `Redo ${stack.redo.toLowerCase()} (⇧⌘Z)` : "Nothing to redo"} aria-label="Redo">
                <IconRedo />
              </button>
            </div>
            <ThemePicker current={board.theme} open={themeOpen} setOpen={setThemeOpen} onPick={(t) => void agent.stub.setTheme(t)} />
            <button className="btn hide-sm" aria-pressed={chatOpen} onClick={() => setChat(!chatOpen)} title="Assistant (/)">
              <IconChat />Assistant
            </button>
            <div className="anchor">
              <button className="btn icon" title={me.email} aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}><IconUser /></button>
              {menuOpen && (
                <Popover onClose={() => setMenuOpen(false)}>
                  <div className="menu">
                    <div className="who">{me.email}</div>
                    <button onClick={() => { setMenuOpen(false); setQuickAddLane(board.lanes[0]?.id ?? null); }}>New card <kbd>n</kbd></button>
                    <button onClick={() => { setMenuOpen(false); setChat(true); }}>Ask the assistant <kbd>/</kbd></button>
                    <button onClick={() => { setMenuOpen(false); setThemeOpen(true); }}>Change theme <kbd>t</kbd></button>
                    <button onClick={() => { setMenuOpen(false); onConnect(); }}>Connect an agent</button>
                    {usage?.billing && usage.plan === "free" && (
                      <button onClick={() => { setMenuOpen(false); void billing("checkout"); }}>Upgrade to Pro</button>
                    )}
                    {usage?.billing && usage.plan === "pro" && (
                      <button onClick={() => { setMenuOpen(false); void billing("portal"); }}>Manage subscription</button>
                    )}
                    <button className="danger" onClick={() => void signOut()}>Sign out</button>
                  </div>
                </Popover>
              )}
            </div>
          </div>
        </header>

        <BoardView
          board={board} actions={actions} flash={flash}
          quickAddLane={quickAddLane} setQuickAddLane={setQuickAddLane}
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

      <Chat
        agent={agent} board={board} open={chatOpen} model={me.model} onClose={() => setChat(false)} onBusy={onBusy} inputRef={chatInput}
        usage={usage} onUpgrade={() => void billing("checkout")}
      />
      {!chatOpen && <button className="btn primary chat-fab" onClick={() => setChat(true)}><IconChat />Ask</button>}

      {editingCard && (
        <CardEditor
          key={editingCard.id} card={editingCard} lanes={board.lanes}
          onSave={(patch) => void agent.stub.updateCard(editingCard.id, patch)}
          onMove={(laneId) => void agent.stub.moveCard(editingCard.id, laneId, Number.MAX_SAFE_INTEGER)}
          onDelete={() => { const t = editingCard.title; void agent.stub.deleteCard(editingCard.id).then(() => say(`Deleted "${t}"`, true)); }}
          isDone={editingCard.laneId === doneLane && board.lanes.length > 1}
          onToggleDone={board.lanes.length > 1 ? () => {
            const reopen = editingCard.laneId === doneLane;
            const target = reopen ? board.lanes[0].id : doneLane;
            void agent.stub.moveCard(editingCard.id, target, reopen ? 0 : Number.MAX_SAFE_INTEGER)
              .then(() => say(reopen ? `Reopened "${editingCard.title}"` : `Done: "${editingCard.title}"`, true));
          } : undefined}
          onRemoveAttachment={(id) => {
            const name = editingCard.attachments?.find((a) => a.id === id)?.name ?? "file";
            void agent.stub.removeAttachment(editingCard.id, id).then(() => say(`Removed "${name}"`, true));
          }}
          onClose={() => setEditing(null)}
        />
      )}

      {toast && (
        <div className="toast" role="status" key={toast.key}>
          <span>{toast.text}</span>
          {toast.action === "undo" && <button onClick={() => { setToast(null); void undo(); }}>Undo</button>}
          {toast.action === "redo" && <button onClick={() => { setToast(null); void redo(); }}>Redo</button>}
        </div>
      )}
    </div>
  );
}
