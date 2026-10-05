import { useAgent } from "agents/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { TodoAgent } from "../agent";
import type { Usage } from "../billing";
import { keyProof, type BoardKey } from "../sealed";
import { clean, doneLaneId, memberTouch, splitTitleTags, tagsByUse, tidyTags, todoLaneId, type Board, type Card } from "../shared";
import { api, BASE } from "./base";
import { BoardView, DESTRUCTIVE_TOAST_MS, localToday, Popover, type Actions } from "./Board";
import { CardEditor } from "./CardEditor";
import { NewCard, type NewCardInput } from "./NewCard";
import { Chat } from "./Chat";
import { Admin } from "./Admin";
import { Connect } from "./Connect";
import { Demo } from "./Demo";
import { Downgraded, EncryptionDialog, Unlock, type EncryptionStub } from "./Encryption";
import { localSearch } from "./localSearch";
import { recallKey, Vault } from "./vault";
import { FirstRun } from "./FirstRun";
import { NoAgentProvider } from "./AgentNudge";
import { Footer } from "./Footer";
import { Invite } from "./Invite";
import { Legal } from "./Legal";
import { SearchBox } from "./Search";
import { IconChat, IconClose, IconLock, IconRedo, IconUndo, IconUser } from "./icons";
import { Login } from "./Login";
import { membersChanged, MembersDialog, PlanWatch, SharedBadge, SharedButton, SharedNote } from "./Members";
import { isUnknownPath, NotFound } from "./NotFound";
import { applyTheme, readCachedTheme } from "./themes";
import { AskContext, AskOwnerContext, AsksButton, type AnswerFn } from "./Ask";
import { BoardSwitcher } from "./BoardSwitcher";
import { MemberChat } from "./MemberChat";
import { accessChangeText, activityText, asActivity, asMemberAccess, bannerText, boardFromUrl, joinRun, leftReasons, modeOf, roleWord, WhoContext, type ActivityRun, type Boards, type MemberAccess } from "./member";
import { PresenceContext, SessionsButton, usePresence } from "./Sessions";
import { ThemePicker } from "./ThemePicker";
import { fitTopbar } from "./topbarFit";
import { useTitle } from "./title";
import { pageAt, type Page } from "../routes";
import { ADD_CARDS_MAX, ownerTagLike, plainError, plainText } from "../member-rules";
import { Landing, SignedInCard } from "./Landing";

type Me = { email: string; id: string; model: string; /** Shows the Admin link. The admin page's API checks the role itself. */ admin?: boolean };
/** The most one `addCards` frame carries, in characters. A member's frame may be 32 KB (MEMBER_FRAME_MAX in agent.ts); this leaves room. */
const ADD_CARDS_FRAME = 24 * 1024;
// The pages are listed once, in src/routes.ts, for this and for the Worker's 404s.
const pageFromPath = (): Page => pageAt(location.pathname, BASE) ?? "board";

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [page, setPage] = useState<Page>(pageFromPath);

  // `hash` names a section of the page, like "#sessions" on Connect, which scrolls to it once it's drawn.
  const go = useCallback((p: Page, hash = "") => {
    history.pushState(null, "", (p === "board" ? `${BASE}/` : `${BASE}/${p}`) + hash);
    setPage(p);
    scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const onPop = () => setPage(pageFromPath());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const load = useCallback(async () => {
    // Signed out is a 200 with `null`, not a 401, so a visitor's console stays clean.
    const r = await fetch(api("/api/me"));
    setMe(r.ok ? ((await r.json()) as Me | null) : null);
  }, []);

  useEffect(() => {
    applyTheme(readCachedTheme());
    void load();
  }, [load]);

  if (isUnknownPath()) return <NotFound />;
  // The privacy policy and terms are public; everything else needs a session.
  if (page === "privacy" || page === "terms") return <Legal page={page} onBack={() => go("board")} />;
  // The demo board runs in the tab with nobody signed in (Demo.tsx).
  if (page === "demo") return <Demo signedIn={!!me} onHome={() => go("board")} onConnect={(hash) => go("connect", hash)} />;
  if (me === undefined) return <div className="splash">loading</div>;
  // Connect is public too: signed out it shows the setup steps and asks for a sign-in only where a token is made.
  if (page === "connect") return <Connect signedIn={me !== null} onBack={() => go("board")} />;
  // An invite link (// TEAM_BOARDS). Signed out, it sends you to sign in and back.
  if (page === "invite") return <Invite me={me} onSignedOut={() => setMe(null)} />;
  if (me === null) return <Login onSignedIn={load} />;
  // /tasks/pricing is the front page at its pricing section, for someone signed in too.
  if (page === "pricing") return <Landing signedIn signIn={<SignedInCard email={me.email} />} />;
  // Anyone signed in can ask for the page; the server answers 403 unless they're an admin, and the page says so.
  if (page === "admin") return <Admin me={me.email} onBack={() => go("board")} />;
  return <BoardHost me={me} onSignOut={() => setMe(null)} onConnect={(hash) => go("connect", hash)} onAdmin={() => go("admin")} />;
}

/** One line to show on the next board that opens, left by the invite page ("You're on dana's board as a writer"). */
const FLASH = "tasks-board-flash";
function takeFlash(): string | null {
  try { const t = sessionStorage.getItem(FLASH); sessionStorage.removeItem(FLASH); return t; } catch { return null; }
}

/**
 * Which board is on screen: your own, or one someone shared with you (// TEAM_BOARDS). The
 * address says which (`/tasks/?board=<owner id>`), so a reload or a bookmark comes back to it.
 * The id opens nothing by itself. Before a shared board is connected to, the server is asked
 * whether you're on it (`GET /api/board/access`); if not, you get your own board and a line
 * saying so, and nothing keeps knocking on a board that won't open.
 */
function BoardHost({ me, onSignOut, onConnect, onAdmin }: { me: Me; onSignOut(): void; onConnect(hash?: string): void; onAdmin(): void }) {
  const [boardId, setBoardId] = useState<string | null>(() => boardFromUrl(me.id));
  const [access, setAccess] = useState<MemberAccess | null>(null);
  const [boards, setBoards] = useState<Boards | null>(null);
  const [notice, setNotice] = useState<string | null>(takeFlash);

  const loadBoards = useCallback(() => {
    fetch(api("/api/boards")).then(async (r) => { if (r.ok) setBoards((await r.json()) as Boards); }).catch(() => {});
  }, []);
  useEffect(() => { loadBoards(); }, [loadBoards, boardId]);

  // Back to your own board, with the reason. The address drops the board it can't open.
  const fallBack = useCallback((why: string) => {
    history.replaceState(null, "", `${BASE}/`);
    setNotice(why);
    setAccess(null);
    setBoardId(null);
  }, []);

  useEffect(() => {
    const onPop = () => setBoardId(boardFromUrl(me.id));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, [me.id]);

  useEffect(() => {
    if (!boardId) { setAccess(null); return; }
    let off = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setAccess(null);
    const ask = (tries: number) => fetch(api(`/api/board/access?board=${encodeURIComponent(boardId)}`)).then(async (r) => {
      if (off) return;
      if (r.status === 401) { onSignOut(); return; }
      // Asked too fast (a reload loop, many tabs): wait as long as the server says and ask again.
      // It says nothing about the board, so it mustn't read as "not shared with you".
      if (r.status === 429) {
        if (tries >= 3) { fallBack("That board couldn't be reached just now. This is your own board."); return; }
        timer = setTimeout(() => { void ask(tries + 1); }, Math.min(15, Math.max(1, Number(r.headers.get("Retry-After")) || 2)) * 1000);
        return;
      }
      const a = r.ok ? asMemberAccess(((await r.json()) as { access?: unknown }).access) : null;
      if (off) return;
      if (a) setAccess(a);
      // One answer for a board that was unshared, one you were never on, and one that doesn't exist: the server doesn't say which.
      else fallBack("That board isn't shared with you. You may have been removed, or the link is wrong. This is your own board.");
    }).catch(() => { if (!off) fallBack("That board couldn't be reached just now. This is your own board."); });
    void ask(0);
    return () => { off = true; clearTimeout(timer); };
  }, [boardId]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchTo = useCallback((board: string | null) => {
    history.pushState(null, "", board ? `${BASE}/?board=${board}` : `${BASE}/`);
    setAccess(null);
    setBoardId(board);
  }, []);

  if (boardId && (!access || access.board !== boardId)) return <div className="splash">opening the board</div>;
  return (
    <Workspace
      // A different board is a different connection and a clean slate: nothing from one leaks into the next.
      key={boardId ?? "own"}
      me={me} onSignOut={onSignOut} onConnect={onConnect} onAdmin={onAdmin}
      shared={boardId ? access : null} boards={boards} onSwitch={switchTo} onLost={fallBack} onBoards={loadBoards}
      notice={notice} onNoticeShown={() => setNotice(null)}
    />
  );
}

type WorkspaceProps = {
  me: Me; onSignOut(): void; onConnect(hash?: string): void;
  /** Open the admin page. The menu only offers it to an admin, and only on their own board. */
  onAdmin(): void;
  /** Set when the board is someone else's: what the server said this account may do there. Null on your own board. */
  shared: MemberAccess | null;
  boards: Boards | null;
  onSwitch(board: string | null): void;
  /** The shared board is gone for this account (removed, left, encrypted): go back to your own, and say why. */
  onLost(why: string): void;
  /** Read the list of boards again. */
  onBoards(): void;
  /** Something to say once the board is up, like why you're back on your own. */
  notice: string | null;
  onNoticeShown(): void;
};

function Workspace({ me, onSignOut, onConnect, onAdmin, shared, boards, onSwitch, onLost, onBoards, notice, onNoticeShown }: WorkspaceProps) {
  useTitle("Board");
  // Everything below asks `mode`, never the URL or a guess: "owner" on your own board, and on a
  // shared one whatever the server last said (the preflight, then `tasks_access` on the socket).
  const member = !!shared;
  const [access, setAccess] = useState<MemberAccess | null>(shared);
  const accessRef = useRef(access);
  accessRef.current = access;
  const mode = modeOf(access);
  const canWrite = mode !== "viewer";
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
  const [membersOpen, setMembersOpen] = useState(false);
  // The assistant panel. Whoever opened or closed it gets it back that way ("todo-chat"). With no
  // choice saved it waits for the board (receive, below): open beside a board that has cards,
  // closed on an empty one, so a new account's first screen is // START_HERE and the lanes.
  const chatSaved = useRef<string | null>(null);
  const [chatOpen, setChatOpen] = useState(() => {
    try { chatSaved.current = localStorage.getItem("todo-chat"); } catch { /* private window */ }
    // On a shared board the panel starts closed; the saved choice is about your own board.
    return !member && chatSaved.current === "open" && innerWidth > 900;
  });
  /**
   * `steps` are the undo steps the toast's Undo means (cards someone else deleted, oldest
   * first): they're undone only if they're still the last ones, all of them or none.
   * `cards` is how many cards that brings back, for what the toast says afterwards.
   */
  const [toast, setToast] = useState<{ text: string; action: "undo" | "redo" | null; key: number; ms?: number; steps?: number[]; cards?: number } | null>(null);
  const toastKey = useRef<number | null>(null);
  toastKey.current = toast?.key ?? null;
  // A run of deletions by one person, shown as one toast (joinRun in member.tsx).
  const run = useRef<ActivityRun | null>(null);

  const boardRef = useRef<Board | null>(null);
  const dragging = useRef(false);
  const newest = useRef<Board | null>(null);
  const pending = useRef<Board | null>(null);
  const agentBusy = useRef(false);
  const chatInput = useRef<HTMLTextAreaElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  // receive() runs before `agent` exists in this render, so it reaches the agent through a ref.
  const agentRef = useRef<{ stub: { setTheme(theme: string): Promise<unknown> }; close(): void } | null>(null);
  // A member's theme is their own: the one this browser already uses. The owner's choice for
  // their board isn't applied here, and picking one here changes this browser, not their board.
  const [localTheme, setLocalTheme] = useState(readCachedTheme);
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
    // The first board decides the assistant panel when nobody has. An empty board keeps it closed,
    // and that's saved, so it doesn't spring open later: it opens when the person opens it.
    if (!member && !prev && chatSaved.current === null && innerWidth > 900) {
      chatSaved.current = next.cards.length ? "open" : "closed";
      if (next.cards.length) setChatOpen(true);
      else try { localStorage.setItem("todo-chat", "closed"); } catch { /* private window */ }
    }
    // A new account (another sign-in email) starts on Auto. Until the user picks a theme
    // on it, keep the one this browser already uses instead of switching under them.
    const cached = readCachedTheme();
    if (member) {
      if (!prev) applyTheme(cached);
    } else if (!prev && !next.themeChosen && cached !== next.theme) {
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
      // Two updates a few milliseconds apart start two transitions, and the browser skips the first.
      // Its callback can then run after the second one's, so each callback shows the newest board
      // it knows of rather than the one it was started with.
      newest.current = next;
      doc.startViewTransition(() => flushSync(() => setBoard(newest.current!)));
    } else {
      newest.current = next;
      setBoard(next);
    }
  }, [member]);

  // Every state update goes through here: plain boards straight to the UI, encrypted ones
  // through the vault first. A newer update always wins over a slower decrypt.
  const ingest = useCallback((s: Board) => {
    rawRef.current = s;
    setRaw(s);
    const n = ++seq.current;
    // Someone else's board is never encrypted (an encrypted board has no members), and the
    // "was encrypted on this device" marker is about your own account's board, not this one.
    if (member) { receive(s); return; }
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

  // `?board=<id>` opens a board someone shared with you; without it, the Worker picks your own
  // from the session cookie. The id opens nothing by itself: the Worker checks membership
  // (// TEAM_BOARDS). BoardHost has already asked the server about it; `shared` is the answer.
  const sharedBoard = shared?.board ?? null;
  const say = useCallback((text: string, undo = false, ms?: number) => setToast({ text, action: undo && !member ? "undo" : null, key: Date.now(), ms }), [member]);

  // Losing the board: stop the socket so nothing reconnects, and hand back to BoardHost, once.
  const lost = useRef(false);
  /** Set while this tab's own Leave is on its way, so the board closing reads as leaving, not as being removed. */
  const leaving = useRef(false);
  const lose = useCallback((why: string) => {
    if (lost.current) return;
    lost.current = true;
    try { agentRef.current?.close(); } catch { /* already closed */ }
    onLost(why);
  }, [onLost]);

  // The server says what this account may do on someone else's board, on connect and again the
  // moment it changes: a role change, the owner's plan lapsing or coming back, removal, or the
  // board being encrypted. The open board follows it on the spot and says what happened.
  const onAccess = useCallback((f: { closed?: string } & Record<string, unknown>) => {
    const was = accessRef.current;
    if (!was) return;
    const next = f.closed ? null : asMemberAccess(f);
    if (!next) {
      lose(f.closed === "encrypted"
        ? `${was.ownerEmail} encrypted their board, which closes it to everyone else. This is your own board.`
        // The server closes the socket before it answers the leave call, so this frame gets here first.
        : leaving.current ? `You left ${was.ownerEmail}'s board. This is your own board.`
        : `You're no longer a member of ${was.ownerEmail}'s board, so it closed. This is your own board.`);
      return;
    }
    const text = accessChangeText(was, next);
    accessRef.current = next;
    setAccess(next);
    if (text) say(text, false, DESTRUCTIVE_TOAST_MS);
  }, [lose, say]);

  // Someone else deleted a card, or brought one back with undo. The card is already gone from
  // the board by the time this arrives, so the toast is the only place its name shows. The
  // owner's has Undo, for that one step and only while it's still the last.
  // Several in a row from one person are one toast ("dana@… deleted 4 cards"), and its Undo
  // covers exactly that run: every step, or nothing if the board has changed since.
  const onActivity = useCallback((raw: unknown) => {
    const f = asActivity(raw);
    if (!f || !activityText(f, me.email)) return;
    const key = Date.now();
    const next = joinRun(run.current, f, toastKey.current, key, !member);
    run.current = next;
    const text = activityText(f, me.email, next);
    if (!text) return;
    // Set here as well as on render: the next frame can arrive before React has drawn this one.
    toastKey.current = key;
    setToast({ text, action: next.steps.length ? "undo" : null, key, ms: DESTRUCTIVE_TOAST_MS, steps: next.steps.length ? next.steps : undefined, cards: next.count });
  }, [me.email, member]);

  // The socket's handler below is made before `refreshUsage` exists, so it reaches it through a ref.
  const usageRef = useRef<() => void>(() => {});
  const agent = useAgent<TodoAgent, Board>({
    agent: "TodoAgent",
    basePath: "tasks/agent",
    ...(sharedBoard ? { query: { board: sharedBoard } } : {}),
    onStateUpdate: (s) => ingest(s),
    // The board's own frames (// TEAM_BOARDS), beside the SDK's: a member's access, and who deleted a card.
    onMessage: (m: MessageEvent) => {
      if (typeof m.data !== "string" || !m.data.slice(0, 40).includes('"type":"tasks_')) return;
      try {
        const f = JSON.parse(m.data) as { type?: string };
        if (f.type === "tasks_access" && sharedBoard) onAccess(f);
        else if (f.type === "tasks_activity") onActivity(f);
        // Your own board's members or plan changed: Members and "Shared with N" read it again now.
        // The plan may be what changed (Pro bought, lapsed, given or taken back by an admin), so
        // the usage call that feeds the account menu and the assistant's meter is made again too.
        else if (f.type === "tasks_members" && !sharedBoard) {
          membersChanged(me.id);
          usageRef.current();
          // Someone left on their own. Nothing else on this screen would say so.
          const left = (f as { left?: unknown }).left;
          if (typeof left === "string" && left) say(`${left} left your board. They can't see it anymore.`, false, DESTRUCTIVE_TOAST_MS);
        }
      } catch { /* not ours */ }
    },
    ...(sharedBoard ? {
      // A dropped socket retries by itself. Before it keeps knocking, ask whether the board is
      // still ours: a member removed while offline gets "Not found" forever otherwise.
      onClose: () => {
        if (lost.current) return;
        const was = accessRef.current;
        fetch(api(`/api/board/access?board=${encodeURIComponent(sharedBoard)}`)).then((r) => {
          if (r.status === 404) lose(`You're no longer a member of ${was?.ownerEmail ?? "that"}'s board, so it closed. This is your own board.`);
          else if (r.status === 401) { lost.current = true; try { agentRef.current?.close(); } catch { /* closed */ } onSignOut(); }
        }).catch(() => {});
      },
    } : {}),
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
  // A member never sees them: claims and Sessions are the owner's.
  const presence = usePresence(!member && !!raw && !raw.sealed);

  // Assistant usage and plan, for the meter in the chat and the upgrade prompts.
  const [usage, setUsage] = useState<Usage | null>(null);
  const refreshUsage = useCallback(() => { if (!member) agent.stub.usage().then(setUsage).catch(() => {}); }, [agent, member]);
  usageRef.current = refreshUsage;
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

  // Leaving a shared board is the member's own call, and takes two taps on the same item.
  const [leaveArmed, setLeaveArmed] = useState(false);
  useEffect(() => { if (!menuOpen) setLeaveArmed(false); }, [menuOpen]);
  const leave = useCallback(async () => {
    const a = accessRef.current;
    if (!a) return;
    leaving.current = true;
    const r = await fetch(api("/api/boards/leave"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ board: a.board }) }).catch(() => null);
    leaving.current = false;
    if (r?.ok) { lose(`You left ${a.ownerEmail}'s board. This is your own board.`); return; }
    const data = r ? ((await r.json().catch(() => ({}))) as { error?: string }) : {};
    say(data.error ?? "Leaving didn't go through. Try again in a minute.");
  }, [lose, say]);

  // Keep the Undo and Redo buttons' labels current.
  useEffect(() => {
    if (!board || member) return; // undo is the owner's
    agent.stub.undoRedo().then(setStack).catch(() => {});
  }, [board, agent, member]);

  // Why you're here, when BoardHost has something to say: back on your own board after losing
  // a shared one, or just in from an invite. It waits for the board so the toast has a page to sit on.
  useEffect(() => {
    if (!notice || !board) return;
    say(notice, false, 12_000);
    onNoticeShown();
  }, [notice, !!board]); // eslint-disable-line react-hooks/exhaustive-deps

  // A change the server turned down: say why in its words, and put the board back the way the
  // server has it, since a drag had already moved the card on screen.
  const refused = useCallback((e: unknown) => {
    // The server's own sentence, without the code some of them start with ("[slow_down] Slow down. …").
    say(e instanceof Error && e.message ? plainError(e.message) : "That didn't work.", false, DESTRUCTIVE_TOAST_MS);
    if (newest.current && !dragging.current) setBoard(newest.current);
  }, [say]);

  // A writer made a viewer, or the owner's plan lapsing, while something was half done: close
  // what can no longer be finished, so nothing on screen offers a change the server will refuse.
  useEffect(() => {
    if (canWrite) return;
    setNewCardLane(null);
    setQuickAddLane(null);
    setChatOpen(false);
  }, [canWrite]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.ms ?? 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const redo = useCallback(async () => {
    if (member) return;
    const label = await agent.stub.redo();
    setToast({ text: label ? `Redid: ${label.toLowerCase()}` : "Nothing to redo", action: label ? "undo" : null, key: Date.now() });
  }, [agent, member]);

  const undo = useCallback(async (steps?: number[], cards?: number) => {
    if (member) return;
    if (steps?.length) {
      const moved = { text: "The board has changed since then, so that can't be undone from here. Undo in the top bar steps back through what came after.", action: null, key: Date.now(), ms: DESTRUCTIVE_TOAST_MS };
      if (steps.length === 1) {
        const done = await agent.stub.undoIf(steps[0]);
        setToast(done ? { text: `Undid: ${done.toLowerCase()}`, action: "redo", key: Date.now() } : moved);
        return;
      }
      // A run: every step or none. Redo in the top bar puts them back one at a time, so no Redo is offered here.
      const n = await agent.stub.undoRun(steps);
      setToast(n ? { text: `Brought back ${cards ?? n} cards`, action: null, key: Date.now() } : moved);
      return;
    }
    const label = await agent.stub.undo();
    // Offer Redo right where the eye already is, in case the undo was an accident.
    setToast({ text: label ? `Undid: ${label.toLowerCase()}` : "Nothing to undo", action: label ? "redo" : null, key: Date.now() });
  }, [agent, say, member]);

  // For the Tags field in the card dialogs. On an encrypted board this is the decrypted view, so it works there too.
  // A member isn't offered the tags that direct the owner's agents: the server would refuse them.
  const knownTags = useMemo(() => (board ? tagsByUse(board).filter((t) => !member || !ownerTagLike(t)) : []), [board, member]);

  const actions: Actions = useMemo(() => ({
    // Quick add, one card per line, as one change (`addCards`). "Write a haiku #agent" is the
    // title plus a tag: it's split here, in the tab, before anything is sealed. A long paste
    // goes up in pieces small enough for one frame. The first piece that doesn't fully land
    // stops it, and every line that isn't a card yet comes back to stay in the box.
    addCards: async (laneId, lines) => {
      let added = 0;
      let pieces = 0;
      let why: string | null = null;
      const left: string[] = [];
      // Each distinct reason the server gave, with the lines it was given for, in the order they came.
      const reasons = new Map<string, string[]>();
      let untried = 0;
      for (let i = 0; i < lines.length && !left.length;) {
        const piece: { title: string; tags?: string[] }[] = [];
        let size = 0;
        while (i + piece.length < lines.length && piece.length < ADD_CARDS_MAX) {
          const { title, tags } = splitTitleTags(lines[i + piece.length]);
          const item = { title: await out(clean(plainText(title), 200)), ...(tags.length ? { tags: await Promise.all(tags.map(out)) } : {}) };
          const n = JSON.stringify(item).length + 1;
          if (piece.length && size + n > ADD_CARDS_FRAME) break;
          piece.push(item);
          size += n;
        }
        try {
          const r = await agent.stub.addCards(laneId, piece);
          added += r.ids.length;
          pieces += 1;
          if (r.left.length) {
            for (const x of r.left) {
              const reason = plainError(x.error);
              reasons.set(reason, [...(reasons.get(reason) ?? []), lines[i + x.index] ?? ""]);
            }
            const not = new Set(r.left.map((x) => x.index));
            untried = lines.length - (i + piece.length);
            left.push(...lines.slice(i, i + piece.length).filter((_, n) => not.has(n)), ...lines.slice(i + piece.length));
          }
        } catch (e) {
          why = e instanceof Error && e.message ? plainError(e.message) : null;
          left.push(...lines.slice(i));
        }
        i += piece.length;
      }
      // One piece is one undo step, so the toast can offer it. More than one isn't, so it doesn't.
      if (added > 1) say(`Added ${added} cards`, pieces === 1);
      if (reasons.size) why = leftReasons(reasons, untried);
      return { added, left, why };
    },
    moveCard: (id, laneId, index) => agent.stub.moveCard(id, laneId, index).catch(refused),
    addLane: async (name) => { laneClash(name); return agent.stub.addLane(await out(clean(name, 40))); },
    renameLane: async (id, name) => { laneClash(name, id); return agent.stub.renameLane(id, await out(clean(name, 40))); },
    deleteLane: (id) => agent.stub.deleteLane(id),
    moveLane: (id, index) => agent.stub.moveLane(id, index),
    clearLane: (id) => agent.stub.clearLane(id),
    setLaneManual: (id, ids) => agent.stub.setLaneManual(id, ids),
    setLaneSort: (id, by) => agent.stub.setLaneSort(id, by),
    setLaneRole: (id, role) => agent.stub.setLaneRole(id, role),
  }), [agent, out, laneClash, refused, say]);

  const updateCard = useCallback(async (id: string, patch: { title?: string; notes?: string; due?: string | null; tags?: string[] }) => {
    const p: typeof patch = {};
    // Control characters a paste can carry (other than a newline and a tab) are left out here: a member's are refused.
    if (patch.title !== undefined) p.title = await out(clean(plainText(patch.title), 200));
    if (patch.notes !== undefined) p.notes = patch.notes ? await out(plainText(patch.notes).slice(0, 4000)) : "";
    if (patch.due !== undefined) p.due = patch.due ? await out(patch.due) : null;
    if (patch.tags !== undefined) p.tags = await Promise.all(tidyTags(patch.tags).map(out));
    return agent.stub.updateCard(id, p).catch(refused);
  }, [agent, out, refused]);

  // The New card dialog: one change, so one Undo takes the whole card back out.
  const addFullCard = useCallback(async (input: NewCardInput) => {
    return agent.stub.addCard(input.laneId, await out(clean(plainText(input.title), 200)), false, {
      notes: input.notes.trim() ? await out(plainText(input.notes).slice(0, 4000)) : "",
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
    if (!member) try { localStorage.setItem("todo-chat", open ? "open" : "closed"); } catch {}
    if (open) setTimeout(() => chatInput.current?.focus(), 50);
  }, [member]);

  // Keyboard: n new card, / chat, t theme, ⌘Z undo, ⇧⌘Z or Ctrl+Y redo, ⌘K search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const typing = el.closest("input, textarea, select, [contenteditable]") || document.querySelector("dialog[open]");
      // Undo and redo are the owner's; on someone else's board the keys are left to the browser.
      if (!member && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.shiftKey && !typing) { e.preventDefault(); void undo(); return; }
      const isRedo = (e.metaKey || e.ctrlKey) && ((e.key.toLowerCase() === "z" && e.shiftKey) || (e.ctrlKey && e.key.toLowerCase() === "y"));
      if (!member && isRedo && !typing) { e.preventDefault(); void redo(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); searchInput.current?.focus(); searchInput.current?.select(); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      // A viewer's keys change nothing: no new card, and no assistant to ask.
      const writes = modeOf(accessRef.current) !== "viewer";
      if (e.key === "n" && writes && boardRef.current?.lanes[0]) { e.preventDefault(); setQuickAddLane(todoLaneId(boardRef.current.lanes)); }
      if (e.key === "/" && writes) { e.preventDefault(); setChat(true); }
      if (e.key === "t") { e.preventDefault(); setThemeOpen((o) => !o); }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [undo, redo, setChat]);

  // Auto theme follows the OS as it changes.
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => { if ((member ? readCachedTheme() : boardRef.current?.theme) === "auto") applyTheme("auto"); };
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
  if (!board || !raw) return <div className="splash">{access ? `opening ${access.ownerEmail}'s board` : "opening your board"}</div>;

  const doneLane = doneLaneId(board.lanes);
  const open = board.cards.filter((c) => c.laneId !== doneLane);
  const today = localToday();
  const dueToday = open.filter((c) => c.due === today).length;
  const overdue = open.filter((c) => c.due && c.due < today).length;
  const editingCard = board.cards.find((c) => c.id === editing);
  // Names on cards show once a board is shared: you're a member of it, or someone else has
  // changed a card on it. A board only its owner has touched shows none (member.tsx).
  const showWho = member || board.cards.some((c) => (c.by && c.by.email !== me.email) || !!memberTouch(c));
  const banner = access ? bannerText(access) : null;

  return (
    <AskContext.Provider value={answerAsk}>
    <AskOwnerContext.Provider value={access?.ownerEmail ?? null}>
    <Who me={me.email} on={showWho}>
    <NoAgentProvider board={board} onConnect={onConnect} off={member}>
    <div className="app">
      <div className="main">
        <header className="topbar" ref={fitTopbar}>
          <h1 className="wordmark">tasks<span>.</span></h1>
          <BoardSwitcher boards={boards} access={access} onSwitch={onSwitch} onOpen={onBoards} />
          {board.sealed && !sharedBoard && (
            <button className="sealed-chip" title="End-to-end encrypted: only your passphrase opens this board" aria-label="Encrypted. Encryption settings" onClick={() => setEncOpen(true)}>
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
            {/* Undo, questions, Sessions, and the cloud assistant are the owner's. On someone else's board they aren't drawn. */}
            {!member && (
            <div className="btn-pair">
              <button className="btn" onClick={() => void undo()} disabled={!stack.undo} title={stack.undo ? `Undo ${stack.undo.toLowerCase()} (⌘Z)` : "Nothing to undo"} aria-label="Undo">
                <IconUndo /><span className="hide-sm label">Undo</span>
              </button>
              <button className="btn icon" onClick={() => void redo()} disabled={!stack.redo} title={stack.redo ? `Redo ${stack.redo.toLowerCase()} (⇧⌘Z)` : "Nothing to redo"} aria-label="Redo">
                <IconRedo />
              </button>
            </div>
            )}
            {!member && <AsksButton cards={board.cards} presence={presence} open={asksOpen} setOpen={setAsksOpen} onOpenCard={setEditing} />}
            {!member && !board.sealed && (
              <SessionsButton
                presence={presence} open={sessionsOpen} setOpen={setSessionsOpen} onConnect={onConnect}
                cardTitle={(id) => board.cards.find((c) => c.id === id)?.title ?? null}
              />
            )}
            <ThemePicker current={member ? localTheme : board.theme} open={themeOpen} setOpen={setThemeOpen} onPick={(t) => { if (member) setLocalTheme(t as typeof localTheme); else void agent.stub.setTheme(t); }} />
            {canWrite && <button className="btn hide-sm" aria-pressed={chatOpen} onClick={() => setChat(!chatOpen)} title="Assistant (/)" aria-label="Assistant">
              <IconChat /><span className="label">Assistant</span>
            </button>}
            {/* Your own board only. It shows once someone's invited (// TEAM_BOARDS). */}
            {!sharedBoard && <SharedButton userId={me.id} onOpen={() => setMembersOpen(true)} />}
            {!sharedBoard && <PlanWatch userId={me.id} onChange={refreshUsage} />}
            <div className="anchor">
              <button className="btn icon account-btn" title={me.email} aria-label="Account" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}><IconUser />{!sharedBoard && <SharedBadge userId={me.id} />}</button>
              {menuOpen && (
                <Popover menu label={`Account, ${me.email}`} onClose={() => setMenuOpen(false)}>
                  <div className="menu">
                    <div className="who">{me.email}</div>
                    {access ? (
                      <>
                        {/* On someone else's board the menu holds what's yours, and the way out. */}
                        <button role="menuitem" onClick={() => { setMenuOpen(false); onSwitch(null); }}>Go to my board</button>
                        {canWrite && <button role="menuitem" onClick={() => { setMenuOpen(false); setQuickAddLane(todoLaneId(board.lanes)); }}>New card <kbd>n</kbd></button>}
                        {canWrite && <button role="menuitem" onClick={() => { setMenuOpen(false); setChat(true); }}>Ask the assistant <kbd>/</kbd></button>}
                        <button role="menuitem" onClick={() => { setMenuOpen(false); setThemeOpen(true); }}>Change theme <kbd>t</kbd></button>
                        <div className="menu-label h">THIS_BOARD<span className="role-chip" data-role={access.effective}>{roleWord(access)}</span></div>
                        <button
                          className={`danger${leaveArmed ? " armed" : ""}`} role="menuitem"
                          onClick={() => { if (!leaveArmed) { setLeaveArmed(true); return; } setMenuOpen(false); void leave(); }}
                        >{leaveArmed ? `Tap again to leave ${access.ownerEmail}'s board` : "Leave this board"}</button>
                      </>
                    ) : (
                      <>
                    {/* First, because it's the one thing in here with no button or shortcut anywhere else. */}
                    <button role="menuitem" onClick={() => { setMenuOpen(false); onConnect(); }}>Connect an agent</button>
                    {!sharedBoard && <button role="menuitem" onClick={() => { setMenuOpen(false); setMembersOpen(true); }}>Members<SharedNote userId={me.id} /></button>}
                    <button role="menuitem" onClick={() => { setMenuOpen(false); setQuickAddLane(todoLaneId(board.lanes)); }}>New card <kbd>n</kbd></button>
                    <button role="menuitem" onClick={() => { setMenuOpen(false); setChat(true); }}>Ask the assistant <kbd>/</kbd></button>
                    <button role="menuitem" onClick={() => { setMenuOpen(false); setThemeOpen(true); }}>Change theme <kbd>t</kbd></button>
                    <button role="menuitem" onClick={() => { setMenuOpen(false); setEncOpen(true); }}>{board.sealed ? "Encryption" : "Encrypt with a passphrase…"}</button>
                    {usage?.billing && usage.plan === "free" && (
                      <button role="menuitem" onClick={() => { setMenuOpen(false); void billing("checkout"); }}>Upgrade to Pro</button>
                    )}
                    {/* Offered only when there's a Stripe subscription to open (`manage`, from the server). Pro an admin gave has none. */}
                    {usage?.billing && usage.manage && (
                      <button role="menuitem" onClick={() => { setMenuOpen(false); void billing("portal"); }}>Manage subscription</button>
                    )}
                    {/* The admin page is about accounts, not boards, so it sits with what's yours and never on a board shared with you. */}
                    {me.admin && <button role="menuitem" onClick={() => { setMenuOpen(false); onAdmin(); }}>Admin</button>}
                      </>
                    )}
                    <button className="danger" role="menuitem" onClick={() => void signOut()}>Sign out</button>
                  </div>
                </Popover>
              )}
            </div>
          </div>
        </header>

        {/* // START_HERE decides for itself when to show (quickStartOpen in FirstRun.tsx). */}
        {!member && !board.sealed && <FirstRun board={board} onConnect={onConnect} add={addFullCard} say={say} />}
        {/* Whose board this is and what you can do on it, for as long as it's on screen. */}
        {access && banner && (
          <aside className="member-line" role="status" aria-label="Shared board">
            <span className="member-line-mark" aria-hidden="true">$</span>
            <span className="role-chip" data-role={access.effective}>{roleWord(access)}</span>
            <span className="member-line-text"><b>{banner.lead}</b> {banner.rest}</span>
          </aside>
        )}
        <PresenceContext.Provider value={presence}>
        <BoardView
          board={board} actions={actions} flash={flash} mode={mode}
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

      {/* The cloud assistant and its transcript are the owner's. A writer gets the model in the tab; a viewer gets none. */}
      {!member && (
      <Chat
        agent={agent} board={board} vault={board.sealed ? vault : null} open={chatOpen} model={me.model} onClose={() => setChat(false)} onBusy={onBusy} inputRef={chatInput}
        usage={usage} onUpgrade={() => void billing("checkout")}
      />
      )}
      {access && canWrite && <MemberChat agent={agent} board={board} owner={access.ownerEmail} open={chatOpen} onClose={() => setChat(false)} inputRef={chatInput} />}
      {!chatOpen && canWrite && <button className="btn primary chat-fab" onClick={() => setChat(true)}><IconChat />Ask</button>}

      {newCardLane && (
        <NewCard key={newCardLane} lanes={board.lanes} laneId={newCardLane} knownTags={knownTags} vault={vault} board={sharedBoard ?? undefined} onAdd={addFullCard} onClose={() => setNewCardLane(null)} />
      )}
      {editingCard && (
        // The editor shows the session that claimed the card, so it reads the same list the board does.
        <PresenceContext.Provider value={presence}>
        <CardEditor
          key={editingCard.id} card={editingCard} lanes={board.lanes} knownTags={knownTags} vault={board.sealed ? vault : null}
          mode={mode} board={sharedBoard ?? undefined} lapsed={access?.reason === "plan_lapsed"}
          onSave={(patch) => void updateCard(editingCard.id, patch)}
          onMove={(laneId) => void agent.stub.moveCard(editingCard.id, laneId, Number.MAX_SAFE_INTEGER).catch(refused)}
          onMoveNow={(laneId) => {
            const to = board.lanes.find((l) => l.id === laneId)?.name ?? "lane";
            void agent.stub.moveCard(editingCard.id, laneId, Number.MAX_SAFE_INTEGER).then(() => say(`Moved "${editingCard.title}" to ${to}`, true), refused);
          }}
          onDelete={() => { const t = editingCard.title; void agent.stub.deleteCard(editingCard.id).then(() => say(`Deleted "${t}"`, true, DESTRUCTIVE_TOAST_MS), refused); }}
          onClaim={member ? undefined : () => void agent.stub.claimWords(editingCard.id).then(() => say("Marked as your words. Your agents will read this card as yours.", true), refused)}
          isDone={editingCard.laneId === doneLane}
          onToggleDone={doneLane ? () => {
            const reopen = editingCard.laneId === doneLane;
            const target = reopen ? todoLaneId(board.lanes)! : doneLane;
            void agent.stub.moveCard(editingCard.id, target, reopen ? 0 : Number.MAX_SAFE_INTEGER)
              .then(() => say(reopen ? `Reopened "${editingCard.title}"` : `Done: "${editingCard.title}"`, true), refused);
          } : undefined}
          onRemoveAttachment={(id) => {
            const name = editingCard.attachments?.find((a) => a.id === id)?.name ?? "file";
            void agent.stub.removeAttachment(editingCard.id, id).then(() => say(`Removed "${name}"`, true, DESTRUCTIVE_TOAST_MS), refused);
          }}
          onClose={() => setEditing(null)}
        />
        </PresenceContext.Provider>
      )}

      {/* Your own board only, like Members: a shared board's encryption is its owner's. */}
      {encOpen && !sharedBoard && (
        <EncryptionDialog
          view={board} raw={raw} vault={board.sealed ? vault : null} userId={me.id} email={me.email} stub={encStub} say={(t: string) => say(t)}
          onEnabled={unlockWith} onDisabling={expectPlain} onDisabled={lock} onClose={() => setEncOpen(false)}
          onMembers={() => { setEncOpen(false); setMembersOpen(true); }}
        />
      )}
      {membersOpen && !sharedBoard && (
        <MembersDialog me={me} onClose={() => setMembersOpen(false)} onEncryption={() => { setMembersOpen(false); setEncOpen(true); }} />
      )}

      {toast && (
        <div className="toast" role="status" key={toast.key}>
          <span>{toast.text}</span>
          {toast.action === "undo" && <button onClick={() => { const { steps, cards } = toast; run.current = null; setToast(null); void undo(steps, cards); }}>Undo</button>}
          {toast.action === "redo" && <button onClick={() => { setToast(null); void redo(); }}>Redo</button>}
        </div>
      )}
    </div>
    </NoAgentProvider>
    </Who>
    </AskOwnerContext.Provider>
    </AskContext.Provider>
  );
}

/** Turns names on cards on or off for everything inside, and keeps "3m ago" moving (member.tsx). */
function Who({ me, on, children }: { me: string; on: boolean; children: React.ReactNode }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [on]);
  const value = useMemo(() => (on ? { me, now } : null), [on, me, now]);
  return <WhoContext.Provider value={value}>{children}</WhoContext.Provider>;
}
