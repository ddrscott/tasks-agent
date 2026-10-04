import { useAgent } from "agents/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { TodoAgent } from "../agent";
import type { Usage } from "../billing";
import { keyProof, type BoardKey } from "../sealed";
import { clean, tagsByUse, tidyTags, type Board, type Card } from "../shared";
import { api, BASE } from "./base";
import { BoardView, localToday, Popover, type Actions } from "./Board";
import { CardEditor } from "./CardEditor";
import { NewCard, type NewCardInput } from "./NewCard";
import { Chat } from "./Chat";
import { Connect } from "./Connect";
import { Downgraded, EncryptionDialog, Unlock, type EncryptionStub } from "./Encryption";
import { localSearch } from "./localSearch";
import { recallKey, Vault } from "./vault";
import { Footer } from "./Footer";
import { Legal } from "./Legal";
import { SearchBox } from "./Search";
import { IconChat, IconClose, IconLock, IconRedo, IconUndo, IconUser } from "./icons";
import { Login } from "./Login";
import { applyTheme, readCachedTheme } from "./themes";
import { AskContext, AsksButton, type AnswerFn } from "./Ask";
import { PresenceContext, SessionsButton, usePresence } from "./Sessions";
import { ThemePicker } from "./ThemePicker";
import { fitTopbar } from "./topbarFit";

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
  async function signOut() {
    await fetch(api("/api/auth/logout"), { method: "POST" });
    onSignOut();
  }

  const [board, setBoard] = useState<Board | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [stack, setStack] = useState<{ undo: string | null; redo: string | null }>({ undo: null, redo: null });
  const [editing, setEditing] = useState<string | null>(null);
  /** Show only cards with this tag; the rest fade back. Per tab, not saved. */
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [quickAddLane, setQuickAddLane] = useState<string | null>(null);
  const [newCardLane, setNewCardLane] = useState<string | null>(null);
  const [themeOpen, setThemeOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [asksOpen, setAsksOpen] = useState(false);
  const [encOpen, setEncOpen] = useState(false);
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

  // End-to-end encryption. `raw` is the board as the server holds it; on an encrypted board
  // that's ciphertext, and `board` is the decrypted view. The vault holds the unlocked key.
  const [raw, setRaw] = useState<Board | null>(null);
  const rawRef = useRef<Board | null>(null);
  const [vault, setVault] = useState<Vault | null>(null);
  const vaultRef = useRef<Vault | null>(null);
  const [recalling, setRecalling] = useState(true);
  const seq = useRef(0);

  // A marker in localStorage remembers that this account's board was encrypted on this
  // device (the key id), or that a tab here is turning it off ("off:<time>"). A plain board
  // arriving while the marker says encrypted is a downgrade nobody here asked for.
  const markerKey = `tasks-sealed:${me.id}`;
  const marker = {
    get: () => { try { return localStorage.getItem(markerKey); } catch { return null; } },
    set: (v: string) => { try { localStorage.setItem(markerKey, v); } catch { /* private window */ } },
    clear: () => { try { localStorage.removeItem(markerKey); } catch { /* private window */ } },
  };
  const [downgraded, setDowngraded] = useState(false);

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

  // Every state update goes through here: plain boards straight to the UI, encrypted ones
  // through the vault first. A newer update always wins over a slower decrypt.
  const ingest = useCallback((s: Board) => {
    rawRef.current = s;
    setRaw(s);
    const n = ++seq.current;
    if (!s.sealed) {
      const m = marker.get();
      if (m && !m.startsWith("off:")) setDowngraded(true);
      else if (m) marker.clear();
      receive(s);
      return;
    }
    marker.set(s.sealed.kid);
    const v = vaultRef.current;
    if (!v || v.key.kid !== s.sealed.kid) { applyTheme(s.theme); boardRef.current = null; setBoard(null); return; }
    void v.openBoard(s).then((view) => { if (n === seq.current) receive(view); });
  }, [receive]);

  const unlockWith = useCallback((k: BoardKey) => {
    const v = new Vault(k);
    vaultRef.current = v;
    setVault(v);
    if (rawRef.current) ingest(rawRef.current);
  }, [ingest]);

  /** This tab is about to turn encryption off or reset the board (true), or that failed (false). */
  const expectPlain = useCallback((active: boolean) => {
    const kid = rawRef.current?.sealed?.kid;
    if (active) marker.set(`off:${Date.now()}`);
    else if (kid) marker.set(kid);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const lock = useCallback(() => {
    vaultRef.current = null;
    setVault(null);
  }, []);

  const agent = useAgent<TodoAgent, Board>({
    agent: "TodoAgent",
    basePath: "tasks/agent", // the Worker picks your board from the session cookie
    onStateUpdate: (s) => ingest(s),
  });

  // Boards encrypted before key checks existed get one from the first tab that unlocks them.
  useEffect(() => {
    if (!vault || !raw?.sealed) return;
    void keyProof(vault.key).then((p) => (agent.stub as unknown as EncryptionStub).ensureKeyCheck(p)).catch(() => {});
  }, [vault, !!raw?.sealed]); // eslint-disable-line react-hooks/exhaustive-deps

  // A key this browser remembers opens the board without asking.
  const sealedKid = raw?.sealed?.kid;
  useEffect(() => {
    if (!raw) return;
    if (!sealedKid || vaultRef.current?.key.kid === sealedKid) { setRecalling(false); return; }
    setRecalling(true);
    void recallKey(me.id, sealedKid).then((k) => { if (k) unlockWith(k); }).finally(() => setRecalling(false));
  }, [!!raw, sealedKid, me.id, unlockWith]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Encrypt text on its way out when the board is encrypted; pass it through when it isn't. */
  const out = useCallback(async (text: string) => {
    const v = vaultRef.current;
    return rawRef.current?.sealed && v ? v.seal(text) : text;
  }, []);
  /** The server can't compare encrypted lane names, so the tab checks for a clash first. */
  const laneClash = useCallback((name: string, except?: string) => {
    const n = clean(name, 40).toLowerCase();
    if (rawRef.current?.sealed && boardRef.current?.lanes.some((l) => l.id !== except && l.name.toLowerCase() === n)) {
      throw new Error(`There is already a lane called "${clean(name, 40)}"`);
    }
  }, []);
  agentRef.current = agent;

  // Claude Code sessions reporting in, and the cards they hold. An encrypted board keeps none.
  const presence = usePresence(!!raw && !raw.sealed);

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

  // For the Tags field in the card dialogs. On an encrypted board this is the decrypted view, so it works there too.
  const knownTags = useMemo(() => (board ? tagsByUse(board) : []), [board]);

  const actions: Actions = useMemo(() => ({
    addCard: async (laneId, title, top) => agent.stub.addCard(laneId, await out(clean(title, 200)), top),
    moveCard: (id, laneId, index) => agent.stub.moveCard(id, laneId, index),
    addLane: async (name) => { laneClash(name); return agent.stub.addLane(await out(clean(name, 40))); },
    renameLane: async (id, name) => { laneClash(name, id); return agent.stub.renameLane(id, await out(clean(name, 40))); },
    deleteLane: (id) => agent.stub.deleteLane(id),
    moveLane: (id, index) => agent.stub.moveLane(id, index),
    clearLane: (id) => agent.stub.clearLane(id),
    sortLane: (id, ids) => agent.stub.sortLane(id, ids),
  }), [agent, out, laneClash]);

  const updateCard = useCallback(async (id: string, patch: { title?: string; notes?: string; due?: string | null; tags?: string[] }) => {
    const p: typeof patch = {};
    if (patch.title !== undefined) p.title = await out(clean(patch.title, 200));
    if (patch.notes !== undefined) p.notes = patch.notes ? await out(patch.notes.slice(0, 4000)) : "";
    if (patch.due !== undefined) p.due = patch.due ? await out(patch.due) : null;
    if (patch.tags !== undefined) p.tags = await Promise.all(tidyTags(patch.tags).map(out));
    return agent.stub.updateCard(id, p);
  }, [agent, out]);

  // The New card dialog: one change, so one Undo takes the whole card back out.
  const addFullCard = useCallback(async (input: NewCardInput) => {
    return agent.stub.addCard(input.laneId, await out(clean(input.title, 200)), false, {
      notes: input.notes.trim() ? await out(input.notes.slice(0, 4000)) : "",
      due: input.due ? await out(input.due) : null,
      tags: await Promise.all(tidyTags(input.tags).map(out)),
    });
  }, [agent, out]);

  // One tap on a question an agent asked (ask_ceo). The answer lands on the card and in the agent's event feed.
  const answerAsk: AnswerFn = useCallback((id, input) => {
    const ask = boardRef.current?.cards.find((c) => c.id === id)?.ask;
    const said = input.text?.trim() || (input.choice !== undefined ? ask?.options[input.choice] : "") || "";
    agent.stub.answerAsk(id, input)
      .then(() => say(`Answered: ${said.length > 60 ? `${said.slice(0, 60)}…` : said}`, true))
      .catch((e: Error) => say(e.message));
  }, [agent, say]);

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

  const searchCards = useCallback(async (query: string) => {
    if (rawRef.current?.sealed) return boardRef.current ? localSearch(boardRef.current, query) : { hits: [], semantic: "off" as const };
    return agent.stub.search({ query, limit: 12 });
  }, [agent]);

  const onBusy = useCallback((b: boolean) => {
    agentBusy.current = b;
    if (!b) refreshUsage(); // a turn just finished, so the count moved
  }, [refreshUsage]);

  const encStub = agent.stub as unknown as EncryptionStub;
  if (raw?.sealed && !vault) {
    if (recalling) return <div className="splash">opening your board</div>;
    return (
      <Unlock
        seal={raw.sealed} userId={me.id} email={me.email} onUnlocked={unlockWith} onSignOut={() => void signOut()}
        onReset={async () => {
          expectPlain(true);
          try { await encStub.resetEncryptedBoard(); } catch (e) { expectPlain(false); throw e; }
        }}
      />
    );
  }
  if (downgraded) {
    return (
      <Downgraded
        email={me.email}
        onAccept={() => { marker.clear(); setDowngraded(false); }}
        onEncrypt={() => { marker.clear(); setDowngraded(false); setEncOpen(true); }}
      />
    );
  }
  if (!board || !raw) return <div className="splash">opening your board</div>;

  const doneLane = board.lanes[board.lanes.length - 1]?.id;
  const open = board.cards.filter((c) => c.laneId !== doneLane || board.lanes.length === 1);
  const today = localToday();
  const dueToday = open.filter((c) => c.due === today).length;
  const overdue = open.filter((c) => c.due && c.due < today).length;
  const editingCard = board.cards.find((c) => c.id === editing);


  return (
    <AskContext.Provider value={answerAsk}>
    <div className="app">
      <div className="main">
        <header className="topbar" ref={fitTopbar}>
          <h1 className="wordmark">tasks<span>.</span></h1>
          {board.sealed && (
            <button className="sealed-chip" title="End-to-end encrypted: only your passphrase opens this board" onClick={() => setEncOpen(true)}>
              <IconLock /><span className="hide-sm label">encrypted</span>
            </button>
          )}
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
          <SearchBox search={searchCards} onOpen={setEditing} inputRef={searchInput} />
          <div className="actions">
            <div className="btn-pair">
              <button className="btn" onClick={() => void undo()} disabled={!stack.undo} title={stack.undo ? `Undo ${stack.undo.toLowerCase()} (⌘Z)` : "Nothing to undo"} aria-label="Undo">
                <IconUndo /><span className="hide-sm label">Undo</span>
              </button>
              <button className="btn icon" onClick={() => void redo()} disabled={!stack.redo} title={stack.redo ? `Redo ${stack.redo.toLowerCase()} (⇧⌘Z)` : "Nothing to redo"} aria-label="Redo">
                <IconRedo />
              </button>
            </div>
            <AsksButton cards={board.cards} open={asksOpen} setOpen={setAsksOpen} onOpenCard={setEditing} />
            {!board.sealed && (
              <SessionsButton
                presence={presence} open={sessionsOpen} setOpen={setSessionsOpen}
                cardTitle={(id) => board.cards.find((c) => c.id === id)?.title ?? null}
              />
            )}
            <ThemePicker current={board.theme} open={themeOpen} setOpen={setThemeOpen} onPick={(t) => void agent.stub.setTheme(t)} />
            <button className="btn hide-sm" aria-pressed={chatOpen} onClick={() => setChat(!chatOpen)} title="Assistant (/)" aria-label="Assistant">
              <IconChat /><span className="label">Assistant</span>
            </button>
            <div className="anchor">
              <button className="btn icon account-btn" title={me.email} aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}><IconUser /></button>
              {menuOpen && (
                <Popover onClose={() => setMenuOpen(false)}>
                  <div className="menu">
                    <div className="who">{me.email}</div>
                    <button onClick={() => { setMenuOpen(false); setQuickAddLane(board.lanes[0]?.id ?? null); }}>New card <kbd>n</kbd></button>
                    <button onClick={() => { setMenuOpen(false); setChat(true); }}>Ask the assistant <kbd>/</kbd></button>
                    <button onClick={() => { setMenuOpen(false); setThemeOpen(true); }}>Change theme <kbd>t</kbd></button>
                    <button onClick={() => { setMenuOpen(false); setEncOpen(true); }}>{board.sealed ? "Encryption" : "Encrypt with a passphrase…"}</button>
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

        <PresenceContext.Provider value={presence}>
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
        </PresenceContext.Provider>
        <Footer />
      </div>

      <Chat
        agent={agent} board={board} vault={board.sealed ? vault : null} open={chatOpen} model={me.model} onClose={() => setChat(false)} onBusy={onBusy} inputRef={chatInput}
        usage={usage} onUpgrade={() => void billing("checkout")}
      />
      {!chatOpen && <button className="btn primary chat-fab" onClick={() => setChat(true)}><IconChat />Ask</button>}

      {newCardLane && (
        <NewCard key={newCardLane} lanes={board.lanes} laneId={newCardLane} knownTags={knownTags} vault={vault} onAdd={addFullCard} onClose={() => setNewCardLane(null)} />
      )}
      {editingCard && (
        <CardEditor
          key={editingCard.id} card={editingCard} lanes={board.lanes} knownTags={knownTags} vault={board.sealed ? vault : null}
          onSave={(patch) => void updateCard(editingCard.id, patch)}
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

      {encOpen && (
        <EncryptionDialog
          view={board} raw={raw} vault={board.sealed ? vault : null} userId={me.id} email={me.email} stub={encStub} say={(t: string) => say(t)}
          onEnabled={unlockWith} onDisabling={expectPlain} onDisabled={lock} onClose={() => setEncOpen(false)}
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
    </AskContext.Provider>
  );
}
