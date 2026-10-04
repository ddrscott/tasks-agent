// The owner's side of team boards (// TEAM_BOARDS in the README): the Members dialog in the
// account menu (invite, the people on the board, pending invites, the audit log) and the
// "Shared with N" button in the top bar. Everything here is the signed-in user's OWN board:
// /api/board/* takes no board id, so there's none to pass and none to get wrong.
//
// The server decides everything. This file shows what it said, in plain words, and disables
// what it would refuse so nobody has to find out by trying. A disabled button here is a
// courtesy, not a lock: src/members.ts checks every call again.

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { Plans } from "../billing";
import type { AuditAction, AuditEntry, Member, MemberRole, Sharing } from "../members";
import { api, BASE } from "./base";
import { IconClose } from "./icons";
import { MODAL, useModal } from "./modal";
import { sharingFacts } from "./sharing";

export type BoardInfo = {
  id: string; ownerEmail: string; plan: "free" | "pro"; sharing: Sharing;
  maxMembers: number; used: number; maxInvitesPerDay: number; invitesToday: number;
};

// ---------- the members list, shared by the top-bar button, this dialog, and Encryption ----------

type Snapshot = { user: string | null; state: "loading" | "ready" | "error"; board: BoardInfo | null; members: Member[]; error: string | null };
const EMPTY: Snapshot = { user: null, state: "loading", board: null, members: [], error: null };
let snap: Snapshot = EMPTY;
let seq = 0;
let loadedAt = 0;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const publish = (next: Snapshot) => { snap = next; for (const fn of listeners) fn(); };

const SIGNED_OUT = "You're signed out. Reload the page and sign in again.";
const OFFLINE = "Couldn't reach the server. Check your connection and try again.";

/** Read the list again. The newest call wins, and a failed reload keeps what was already on screen. */
export async function refreshMembers(userId: string): Promise<void> {
  const n = ++seq;
  // Another account signed in on this tab: nothing of the last one's list may stay on screen.
  if (snap.user !== userId) publish({ ...EMPTY, user: userId });
  let next: Snapshot;
  try {
    const r = await fetch(api("/api/board/members"), { headers: { Accept: "application/json" } });
    const data = (await r.json().catch(() => null)) as { board?: BoardInfo; members?: Member[]; error?: string } | null;
    if (!r.ok || !data?.board || !Array.isArray(data.members)) throw new Error(r.status === 401 ? SIGNED_OUT : "The members list didn't load. Try again in a minute.");
    next = { user: userId, state: "ready", board: data.board, members: data.members, error: null };
  } catch (e) {
    const error = e instanceof TypeError ? OFFLINE : (e as Error).message;
    next = snap.user === userId && snap.board ? { ...snap, error } : { ...EMPTY, user: userId, state: "error", error };
  }
  if (n !== seq) return;
  loadedAt = Date.now();
  publish(next);
}

// The board's object tells the owner's socket the moment membership or the plan changes (a
// `tasks_members` frame, App.tsx). That's what keeps this list, "Shared with N", and an open
// audit log current; the timers below are only a backstop for a frame that never came.
let changes = 0;
const changeListeners = new Set<() => void>();
const subscribeChanges = (fn: () => void) => { changeListeners.add(fn); return () => { changeListeners.delete(fn); }; };
/** Membership or the plan just changed on the signed-in user's own board: read it all again. */
export function membersChanged(userId: string): void {
  changes += 1;
  for (const fn of changeListeners) fn();
  void refreshMembers(userId);
}

/** The signed-in user's own board: who's on it and what its owner may do right now. */
export function useBoardMembers(userId: string): Snapshot {
  const s = useSyncExternalStore(subscribe, () => snap);
  useEffect(() => { if (snap.user !== userId) void refreshMembers(userId); }, [userId]);
  return s.user === userId ? s : EMPTY;
}

const accepted = (members: Member[]) => members.filter((m) => m.status === "accepted");
const pendingOf = (members: Member[]) => members.filter((m) => m.status === "pending");
const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
const invites = (n: number) => `${n} pending invite${n === 1 ? "" : "s"}`;
const a = (role: MemberRole) => `a ${role}`;

const IconPeople = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.2A6.5 6.5 0 0 1 21.5 20" />
  </svg>
);

/**
 * The top bar's sign that this board is shared, so its owner never forgets who can see it.
 * Nothing shows on a board nobody was invited to. It opens Members.
 */
export function SharedButton({ userId, onOpen }: { userId: string; onOpen(): void }) {
  const { board, members } = useBoardMembers(userId);
  // Someone accepting or leaving doesn't reach this tab on its own, so look again when the
  // owner comes back to it.
  useEffect(() => {
    const look = () => { if (document.visibilityState === "visible" && Date.now() - loadedAt > 15_000) void refreshMembers(userId); };
    addEventListener("focus", look);
    document.addEventListener("visibilitychange", look);
    return () => { removeEventListener("focus", look); document.removeEventListener("visibilitychange", look); };
  }, [userId]);

  if (!board || members.length === 0) return null;
  const on = accepted(members).length;
  const waiting = members.length - on;
  const lapsed = board.sharing === "suspended";
  const summary = lapsed
    ? `Sharing is paused: your Pro plan isn't active. ${on ? `${people(on)} can still see this board, view only` : "Nobody has joined yet"}${waiting ? `, and ${invites(waiting)}` : ""}`
    : on
      ? `${people(on)} can see this board${waiting ? `, and ${invites(waiting)}` : ""}`
      : `Nobody has joined yet. ${invites(waiting)}`;
  return (
    <button className={`btn shared-btn${lapsed ? " paused" : ""}`} aria-haspopup="dialog" onClick={onOpen} title={`${summary}. Open Members.`} aria-label={`${summary}. Open Members`}>
      <IconPeople /><span className="hide-sm label">{lapsed ? "Sharing paused" : on ? "Shared with" : "Invited"}</span>
      {/* Paused, the count alone would read as business as usual on a phone, where the label doesn't fit. */}
      <span className="shared-count">{lapsed && <span className="shared-paused" aria-hidden="true">paused · </span>}{on || waiting}</span>
    </button>
  );
}

/**
 * Tells the board when the owner's plan, as the members list reports it, changes. The plan
 * label by the assistant and the Upgrade or Manage item in the account menu come from a
 * usage call that's otherwise only made now and then, so after a lapse they went on saying "pro".
 */
export function PlanWatch({ userId, onChange }: { userId: string; onChange(): void }) {
  const { board } = useBoardMembers(userId);
  const plan = board?.plan;
  const first = useRef(true);
  useEffect(() => {
    if (plan === undefined) return;
    if (first.current) { first.current = false; return; }
    onChange();
  }, [plan]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/**
 * The same count as a mark on the account button, for a bar too tight to hold the button
 * (topbarFit.ts, the "shared" step). Members is in that button's menu, so the way in is still there.
 */
export function SharedBadge({ userId }: { userId: string }) {
  const { board, members } = useBoardMembers(userId);
  if (members.length === 0) return null;
  // Paused, the mark says so instead of counting.
  return <span className="shared-badge" aria-hidden="true">{board?.sharing === "suspended" ? "paused" : accepted(members).length || members.length}</span>;
}

/** Beside "Members" in the account menu: how many people that is right now. */
export function SharedNote({ userId }: { userId: string }) {
  const { board, members } = useBoardMembers(userId);
  if (members.length === 0) return null;
  const on = accepted(members).length;
  if (board?.sharing === "suspended") return <span className="menu-note">sharing paused</span>;
  return <span className="menu-note">{on ? `shared with ${on}` : `${members.length} invited`}</span>;
}

// ---------- plain words ----------

// What each role can do, from the Roles table in the README and MEMBER_CALLS in member-rules.ts.
const ROLES: { role: MemberRole; label: string; can: string }[] = [
  { role: "viewer", label: "Viewer", can: "Sees the board live, searches it, and downloads its files. Can't change anything." },
  { role: "writer", label: "Writer", can: "Everything a viewer can, plus adding, editing, moving, and deleting cards and their files. Lanes, undo, agents' questions, the cloud assistant, and every setting stay yours." },
];

type Failure = { status: number; code?: string; error?: string };

/** Every refusal the members API gives, in words for the person looking at the screen. */
function explain(f: Failure, board: BoardInfo | null, email = ""): string {
  const who = email || "That address";
  switch (f.code) {
    case "bad_email": return "That doesn't look like an email address we can invite. Use plain letters, digits, and punctuation: no accented or look-alike characters.";
    case "bad_role": return "Pick viewer or writer.";
    case "self": return "That's you. You already own this board.";
    case "pro_required": return "Sharing is part of Pro, and this account isn't on Pro right now. Nothing was sent.";
    case "board_encrypted": return "This board is end-to-end encrypted, so it can't be shared. Turn encryption off first.";
    case "member_limit": return `This board is full: ${board ? `${board.maxMembers} of ${board.maxMembers}` : "every one of its"} people, pending invites included. Remove someone or revoke an invite first.`;
    case "invite_limit": return `You've sent today's ${board ? board.maxInvitesPerDay : ""} invite emails. The count starts over at midnight UTC.`.replace("  ", " ");
    case "already_member": return `${who} already accepted, so there's no invite to resend.`;
    case "email_failed": return `The invite for ${who} is saved, but the email didn't go out. Hit Resend in a minute.`;
    case "not_found": return `${who} isn't on this board anymore. The list below is current.`;
  }
  if (f.status === 401) return SIGNED_OUT;
  if (f.status === 0) return OFFLINE;
  if (f.status === 403) return "That request was refused. Reload the page and try again.";
  return f.error && f.error.length < 200 ? f.error : "That didn't work. Try again in a minute.";
}

async function post<T>(path: string, body: unknown): Promise<{ ok: true; status: number; data: T } | ({ ok: false } & Failure)> {
  try {
    const r = await fetch(api(path), { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
    const data = (await r.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
    if (!r.ok || !data) return { ok: false, status: r.status, code: data?.code, error: data?.error };
    return { ok: true, status: r.status, data };
  } catch {
    return { ok: false, status: 0 };
  }
}

// Times. An admin pastes these into a ticket, so every one says its zone, and the UTC time is
// printed next to it in the audit log instead of hiding in a tooltip a phone can't open.
const iso = (ms: number) => new Date(ms).toISOString();
const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const stamp = (ms: number) => new Date(ms).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const stampSeconds = (ms: number) => new Date(ms).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" });
const When = ({ at, text }: { at: number; text: string }) => <time dateTime={iso(at)} title={`${iso(at)} (UTC)`}>{text}</time>;

function price(p: NonNullable<Plans["pro"]>["price"]): string {
  if (!p) return "";
  try {
    const money = new Intl.NumberFormat(undefined, { style: "currency", currency: p.currency.toUpperCase() });
    const digits = money.resolvedOptions().maximumFractionDigits ?? 2;
    return ` Pro is ${money.format(p.amount / 10 ** digits)} ${p.intervalCount === 1 ? `a ${p.interval}` : `every ${p.intervalCount} ${p.interval}s`}.`;
  } catch {
    return "";
  }
}

// ---------- the dialog ----------

type Note = { kind: "ok" | "error"; text: string };
type Props = {
  me: { id: string; email: string };
  onClose(): void;
  /** Open the Encryption dialog instead (an encrypted board's way back to sharing). */
  onEncryption(): void;
};

export function MembersDialog({ me, onClose, onEncryption }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  // Opened from the account menu, whose item is gone by the time this closes: go back to the menu's button.
  useModal(ref, { focus: (d) => d.focus(), fallback: () => document.querySelector<HTMLElement>(".account-btn") });
  const { state, board, members, error: loadError } = useBoardMembers(me.id);
  const [tab, setTab] = useState<"people" | "audit">("people");
  const ids = useId();

  // Always the current list when the dialog opens. While it stays open, the board says when
  // something changed (membersChanged, above), and that's what refreshes it; this once-a-minute
  // look is for the case where the socket was down when it happened.
  useEffect(() => {
    void refreshMembers(me.id);
    const t = setInterval(() => { if (document.visibilityState === "visible") void refreshMembers(me.id); }, 60_000);
    return () => clearInterval(t);
  }, [me.id]);

  // Whether Pro is for sale here at all, and for how much (GET /api/plans, the pricing page's source).
  const [plans, setPlans] = useState<Plans | null>(null);
  useEffect(() => {
    let live = true;
    fetch(api("/api/plans")).then((r) => (r.ok ? (r.json() as Promise<Plans>) : null)).then((p) => { if (live && p) setPlans(p); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const tabs = [
    { id: "people" as const, label: "People" },
    { id: "audit" as const, label: "Audit log" },
  ];
  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = tab === "people" ? "audit" : "people";
    setTab(next);
    document.getElementById(`${ids}-tab-${next}`)?.focus();
  };

  return (
    <dialog ref={ref} {...MODAL} aria-labelledby={`${ids}-title`} className="members-dialog" tabIndex={-1} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      {/* The heading, the X, and the tabs stay put; what's under them scrolls. */}
      <div className="mem-head">
        <div className="dialog-top">
          <h2 className="h" id={`${ids}-title`}>MEMBERS</h2>
          <button className="btn ghost icon dialog-x" onClick={onClose} aria-label="Close Members" title="Close (Esc)"><IconClose /></button>
        </div>
        <div className="mem-tabs" role="tablist" aria-label="Members sections" onKeyDown={onTabKey}>
          {tabs.map((t) => (
            <button key={t.id} role="tab" id={`${ids}-tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`${ids}-panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1} onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </div>
      </div>
      <div className="dialog-body">
        {tab === "people" && (
          <div className="mem-panel" role="tabpanel" id={`${ids}-panel-people`} aria-labelledby={`${ids}-tab-people`}>
            {!board && state === "loading" && <p className="mem-loading">loading who's on this board</p>}
            {!board && state === "error" && (
              <div className="mem-state" role="alert">
                <p>{loadError}</p>
                <div className="mem-actions"><button className="btn" onClick={() => void refreshMembers(me.id)}>Try again</button></div>
              </div>
            )}
            {board && <People me={me} board={board} members={members} plans={plans} stale={loadError} onEncryption={onEncryption} onAudit={() => setTab("audit")} />}
          </div>
        )}
        {tab === "audit" && (
          <div className="mem-panel" role="tabpanel" id={`${ids}-panel-audit`} aria-labelledby={`${ids}-tab-audit`}>
            <AuditLog me={me} />
          </div>
        )}
      </div>
    </dialog>
  );
}

function People({ me, board, members, plans, stale, onEncryption, onAudit }: {
  me: Props["me"]; board: BoardInfo; members: Member[]; plans: Plans | null; stale: string | null; onEncryption(): void; onAudit(): void;
}) {
  const on = accepted(members);
  const waiting = pendingOf(members);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("viewer");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  /** The invite link the dev server hands back instead of sending mail. Never set in production: the API doesn't return one. */
  const [devLink, setDevLink] = useState<{ email: string; link: string } | null>(null);
  const [copied, setCopied] = useState(false);
  /** The Remove or Revoke that's been tapped once, as "remove:<email>". */
  const [armed, setArmed] = useState<string | null>(null);
  const [billingError, setBillingError] = useState<string | null>(null);
  const noteRef = useRef<HTMLParagraphElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const ids = useId();
  // "Sharing paused" in the top bar opens this dialog at the reason: the block that explains
  // the pause takes focus, so it's what's on screen and what a screen reader says first.
  const pausedRef = useRef<HTMLDivElement>(null);
  const paused = board.sharing === "suspended";
  useEffect(() => { if (paused) pausedRef.current?.focus(); }, [paused]);

  const billingOn = plans ? plans.pro !== null : null;
  const full = board.used >= board.maxMembers;
  const invitesLeft = Math.max(0, board.maxInvitesPerDay - board.invitesToday);
  const canInvite = board.sharing === "on";
  const blocked = canInvite && full ? "full" : canInvite && invitesLeft === 0 ? "spent" : null;

  /** Say what happened where a screen reader hears it, and put focus there when the row that had it is gone. */
  const tell = (n: Note, focus = false) => {
    setNote(n);
    if (focus) requestAnimationFrame(() => noteRef.current?.focus());
  };

  async function goBilling(kind: "checkout" | "portal") {
    setBillingError(null);
    setBusy(kind);
    const r = await post<{ url?: string }>(`/api/billing/${kind}`, {});
    // Only ever a web address: Stripe's checkout or portal page.
    if (r.ok && typeof r.data.url === "string" && /^https?:\/\//.test(r.data.url)) { location.assign(r.data.url); return; }
    setBusy(null);
    setBillingError(!r.ok && r.status === 0 ? OFFLINE : (!r.ok && r.error) || "Billing is having trouble. Try again in a minute.");
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !canInvite || blocked) return;
    setFormError(null);
    setDevLink(null);
    // What the last invite said isn't about this one. Left up, "Invited dana@…" sat right
    // under a red error for the next address.
    setNote(null);
    // The same trim and lower-casing the server does (inviteEmail in member-rules.ts), so the
    // checks against the list below compare like with like.
    const to = email.trim().toLowerCase();
    if (!to) { setFormError("Type the email address of the person to invite."); emailRef.current?.focus(); return; }
    if (to === me.email) { setFormError(explain({ status: 400, code: "self" }, board)); return; }
    const have = members.find((m) => m.email === to);
    // The API would treat these as "change their role" and "send a new link". Neither is what
    // typing an address into Invite looks like it does, so point at the row instead.
    if (have?.status === "accepted") { setFormError(`${to} is already on this board as ${a(have.role)}. To change that, use the role menu next to their name below.`); return; }
    if (have) { setFormError(`${to} already has a pending invite as ${a(have.role)}. Use Resend below to send a new link.`); return; }

    setBusy("invite");
    const r = await post<{ member: Member; devLink?: string; changed?: boolean }>("/api/board/invites", { email: to, role });
    setBusy(null);
    if (!r.ok) {
      setFormError(explain(r, board, to));
      // The plan, the cap, or the list changed under this dialog. Show what's true now.
      void refreshMembers(me.id);
      return;
    }
    const m = r.data.member;
    if (m.status === "accepted") {
      tell({ kind: "ok", text: r.data.changed ? `${m.email} was already on this board. They're ${a(m.role)} now.` : `${m.email} is already on this board as ${a(m.role)}. Nothing changed.` });
    } else {
      tell({ kind: "ok", text: `Invited ${m.email} as ${a(m.role)}. The link in the email works once${m.expiresAt ? ` and expires ${stamp(m.expiresAt)}` : ""}. They get access when they accept it, signed in as that address.` });
      if (r.data.devLink) setDevLink({ email: m.email, link: r.data.devLink });
    }
    setEmail("");
    setCopied(false);
    void refreshMembers(me.id);
  }

  async function resend(m: Member) {
    setBusy(`resend:${m.email}`);
    setDevLink(null);
    const r = await post<{ member: Member; devLink?: string }>("/api/board/invites/resend", { email: m.email });
    setBusy(null);
    if (!r.ok) tell({ kind: "error", text: explain(r, board, m.email) });
    else {
      tell({ kind: "ok", text: `Sent ${m.email} a new invite. The old link is dead; the new one expires ${r.data.member.expiresAt ? stamp(r.data.member.expiresAt) : "in 7 days"}.` });
      if (r.data.devLink) { setDevLink({ email: m.email, link: r.data.devLink }); setCopied(false); }
    }
    void refreshMembers(me.id);
  }

  async function drop(m: Member) {
    const key = `drop:${m.email}`;
    if (armed !== key) { setArmed(key); return; }
    setArmed(null);
    setBusy(key);
    const pending = m.status === "pending";
    const r = await post<{ ok: true }>(pending ? "/api/board/invites/revoke" : "/api/board/members/remove", { email: m.email });
    setBusy(null);
    if (devLink?.email === m.email) setDevLink(null);
    if (!r.ok) tell({ kind: "error", text: explain(r, board, m.email) }, true);
    else tell({ kind: "ok", text: pending ? `Revoked the invite for ${m.email}. Its link no longer works.` : `Removed ${m.email}. Any tab they had open on this board lost it right away.` }, true);
    void refreshMembers(me.id);
  }

  async function changeRole(m: Member, next: MemberRole) {
    if (next === m.role) return;
    setBusy(`role:${m.email}`);
    const r = await post<{ member: Member; changed: boolean }>("/api/board/members/role", { email: m.email, role: next });
    setBusy(null);
    if (!r.ok) tell({ kind: "error", text: explain(r, board, m.email) });
    else if (m.status === "pending") tell({ kind: "ok", text: `${m.email}'s invite is for ${a(next)} now. The link they have still works.` });
    else tell({ kind: "ok", text: `${m.email} is ${a(next)} now. It took effect right away, in any tab they have open.` });
    void refreshMembers(me.id);
  }

  async function copy() {
    if (!devLink) return;
    try { await navigator.clipboard.writeText(devLink.link); setCopied(true); } catch { setCopied(false); }
  }

  const upgrade = (
    <>
      {billingOn && <button type="button" className="btn primary" disabled={!!busy} onClick={() => void goBilling("checkout")}>{busy === "checkout" ? "Opening checkout…" : "Upgrade to Pro"}</button>}
      {billingError && <p className="mem-error" role="alert">{billingError}</p>}
    </>
  );

  const roleSelect = (m: Member) => (
    <select
      className="field mem-role" aria-label={`Role for ${m.email}`} value={m.role} disabled={busy === `role:${m.email}`}
      onChange={(e) => void changeRole(m, e.target.value as MemberRole)}
    >
      <option value="viewer">viewer</option>
      <option value="writer">writer</option>
    </select>
  );
  const dropButton = (m: Member) => {
    const key = `drop:${m.email}`;
    const isArmed = armed === key;
    const verb = m.status === "pending" ? "Revoke" : "Remove";
    return (
      <button
        type="button" className={`btn danger mem-drop${isArmed ? " armed" : ""}`} disabled={busy === key}
        // Two taps, like Clear and Delete in a lane's menu: the first only changes the label.
        onClick={() => void drop(m)} onBlur={() => { if (isArmed) setArmed(null); }}
        aria-label={isArmed ? `Tap again to ${verb.toLowerCase()} ${m.email}` : `${verb} ${m.email}`}
      >
        {isArmed ? `Tap again to ${verb.toLowerCase()}` : verb}
      </button>
    );
  };

  return (
    <>
      {/* Who has access, in one line, before anything else. */}
      {board.sharing === "encrypted" ? (
        <div className="mem-state">
          <p className="mem-state-head"><span className="mem-chip">sharing off</span> This board is end-to-end encrypted, so it can't be shared.</p>
          <p>
            Only your passphrase opens it. The server holds ciphertext it can't read, so it has no way to check what a
            member should see or to serve them the board. It's the same reason outside agents and the cloud assistant are
            closed out. Only you can see this board.
          </p>
          <p>To invite people, turn encryption off first. It works the other way too: a board with members or pending invites can't be encrypted.</p>
          <div className="mem-actions"><button className="btn" onClick={onEncryption}>Encryption settings</button></div>
        </div>
      ) : (
        <p className={`mem-summary${on.length ? " live" : ""}`}>
          {on.length
            ? <>Shared with {people(on.length)}{board.sharing === "suspended" ? ", view only right now" : ""}.{waiting.length ? ` ${invites(waiting.length)}.` : ""}</>
            : waiting.length ? <>Nobody has joined yet. {invites(waiting.length)}.</> : <>Only you can see this board.</>}
          {" "}There's no public link: the only way in is an invite that one email address accepts.
        </p>
      )}

      {board.sharing === "suspended" && (
        <div className="mem-state" ref={pausedRef} tabIndex={-1} aria-label="Sharing is paused">
          <p className="mem-state-head"><span className="mem-chip">view only</span> Your Pro plan isn't active, so sharing is paused.</p>
          <p>
            Nothing was deleted. Everyone below is still on the board with the role you gave them, but until Pro is
            back they can only look: writers can't change anything. New invites and resends are off. You can still
            change roles, remove people, and revoke invites.
          </p>
          {billingOn === false
            ? <p>Pro isn't for sale on this server right now, so there's nothing to buy yet.</p>
            : <p>It all comes back the moment Pro does.{plans?.pro ? price(plans.pro.price) : ""}</p>}
          <div className="mem-actions">
            {upgrade}
            {billingOn && <button type="button" className="linkish" disabled={!!busy} onClick={() => void goBilling("portal")}>Manage subscription</button>}
          </div>
        </div>
      )}

      {board.sharing !== "encrypted" && (
        <section className="mem-section" aria-labelledby={`${ids}-invite`}>
          <h3 className="h" id={`${ids}-invite`}>INVITE</h3>
          <form className="mem-invite" noValidate onSubmit={(e) => void invite(e)}>
            {/* While Pro is lapsed the form would only be dead fields above the list that matters. */}
            {board.sharing !== "suspended" && <>
            <label>
              Email address
              <input
                ref={emailRef} className="field" type="email" name="invite-email" inputMode="email" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                placeholder="name@company.com" maxLength={254} value={email} disabled={!canInvite}
                onChange={(e) => { setEmail(e.target.value); setFormError(null); }}
                aria-describedby={formError ? `${ids}-invite-error` : undefined} aria-invalid={!!formError}
              />
            </label>
            <fieldset className="mem-roles" disabled={!canInvite}>
              <legend>Role</legend>
              {ROLES.map((r) => (
                <label key={r.role} className="mem-role-opt">
                  <input type="radio" name="invite-role" value={r.role} checked={role === r.role} onChange={() => setRole(r.role)} />
                  <span><b>{r.label}</b> {r.can}</span>
                </label>
              ))}
            </fieldset>
            </>}
            {formError && <p className="mem-error" id={`${ids}-invite-error`} role="alert">{formError}</p>}

            {board.sharing === "pro_required" && (
              <div className="mem-gate">
                {billingOn === false ? (
                  <p><b>Sharing is part of Pro, and Pro isn't available here yet.</b> There's nothing to buy on this server, so invites stay off for now.</p>
                ) : (
                  <p><b>Sharing is part of Pro.</b> You pay for the board, and the people you invite join free.{plans?.pro ? price(plans.pro.price) : ""}</p>
                )}
                <div className="mem-actions">{upgrade}</div>
              </div>
            )}
            {board.sharing === "suspended" && (
              <div className="mem-gate"><p><b>Invites are off until Pro is back.</b> The people already here stay listed, view only.</p></div>
            )}
            {canInvite && (
              <div className="mem-submit">
                <button type="submit" className="btn primary" disabled={!!blocked || busy === "invite"}>{busy === "invite" ? "Sending…" : "Invite"}</button>
                <p className="mem-caps">
                  <span className={full ? "mem-warn" : undefined}>{board.used} of {board.maxMembers} people, pending invites included.</span>{" "}
                  <span className={invitesLeft === 0 ? "mem-warn" : undefined}>{invitesLeft} of {board.maxInvitesPerDay} invite emails left today (resets at midnight UTC).</span>
                </p>
              </div>
            )}
            {blocked === "full" && <p className="mem-error" role="status">This board is full: {board.maxMembers} of {board.maxMembers} people, pending invites included. Remove someone or revoke an invite to make room.</p>}
            {blocked === "spent" && <p className="mem-error" role="status">You've sent today's {board.maxInvitesPerDay} invite emails, resends included. The count starts over at midnight UTC.</p>}
          </form>
        </section>
      )}

      {/* One place for what just happened. It takes focus when the row that was focused is gone. */}
      <p className={`mem-note${note ? ` is-${note.kind}` : ""}`} role="status" tabIndex={-1} ref={noteRef}>{note?.text}</p>
      {stale && <p className="mem-error" role="alert">{stale} This list may be out of date.</p>}

      {devLink && (
        <div className="mem-dev">
          <p><span className="mem-chip">dev only</span> No email was sent: this server runs with <code>DEV_LOGIN_CODES=1</code>. This is the link {devLink.email} would get. In production it goes to their inbox and never shows up here.</p>
          <div className="mem-copy">
            <input className="field mono" readOnly value={devLink.link} aria-label={`Dev-only invite link for ${devLink.email}`} onFocus={(e) => e.target.select()} />
            <button type="button" className="btn" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
          </div>
        </div>
      )}

      {board.sharing !== "encrypted" && (
        <>
          <section className="mem-section" aria-labelledby={`${ids}-on`}>
            <h3 className="h" id={`${ids}-on`}>ON_THIS_BOARD</h3>
            <ul className="mem-list">
              <li className="mem-row">
                <div className="mem-who">
                  <span className="mem-email">{board.ownerEmail}</span>
                  <span className="mem-meta">you · the only one who can change members, lanes, and settings</span>
                </div>
                <div className="mem-ctl"><span className="mem-chip">owner</span></div>
              </li>
              {on.map((m) => (
                <li className="mem-row" key={m.email}>
                  <div className="mem-who">
                    <span className="mem-email">{m.email}</span>
                    <span className="mem-meta">
                      member since <When at={m.acceptedAt ?? m.invitedAt} text={day(m.acceptedAt ?? m.invitedAt)} />
                      {board.sharing === "suspended" && m.role === "writer" && <> · <span className="mem-chip">view only for now</span></>}
                    </span>
                  </div>
                  <div className="mem-ctl">{roleSelect(m)}{dropButton(m)}</div>
                </li>
              ))}
            </ul>
            {on.length === 0 && <p className="mem-empty">Nobody else is on this board yet.</p>}
          </section>

          <section className="mem-section" aria-labelledby={`${ids}-pending`}>
            <h3 className="h" id={`${ids}-pending`}>PENDING_INVITES</h3>
            {waiting.length === 0 ? <p className="mem-empty">No invites are waiting on an answer.</p> : (
              <ul className="mem-list">
                {waiting.map((m) => (
                  <li className="mem-row" key={m.email}>
                    <div className="mem-who">
                      <span className="mem-email">{m.email}</span>
                      <span className="mem-meta">
                        sent <When at={m.invitedAt} text={stamp(m.invitedAt)} />
                        {m.expiresAt !== null && (m.expired
                          ? <> · <span className="mem-chip warn">expired</span> <When at={m.expiresAt} text={stamp(m.expiresAt)} />. Resend makes a new link.</>
                          : <> · expires <When at={m.expiresAt} text={stamp(m.expiresAt)} /></>)}
                      </span>
                    </div>
                    <div className="mem-ctl">
                      {roleSelect(m)}
                      <button
                        type="button" className="btn" disabled={!canInvite || invitesLeft === 0 || busy === `resend:${m.email}`} onClick={() => void resend(m)}
                        aria-label={`Resend the invite to ${m.email}`}
                        title={!canInvite ? "Resend is off until Pro is back" : invitesLeft === 0 ? "Today's invite emails are used up" : "Send a new link. The old one stops working."}
                      >{busy === `resend:${m.email}` ? "Sending…" : "Resend"}</button>
                      {dropButton(m)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {waiting.length > 0 && <p className="mem-foot">A pending invite holds a place on the board (it counts toward the {board.maxMembers}) but opens nothing until it's accepted. Links work once and last 7 days.</p>}
          </section>
        </>
      )}
      {/* What a manager asks before approving this, answered where they'd look. */}
      <section className="mem-section" aria-labelledby={`${ids}-how`}>
        <h3 className="h" id={`${ids}-how`}>HOW_SHARING_WORKS</h3>
        <dl className="mem-facts">
          {sharingFacts(board.maxMembers).map((f) => <div key={f.q}><dt>{f.q}</dt><dd>{f.a}</dd></div>)}
        </dl>
        <p className="mem-foot">The same answers are in the <a href={`${BASE}/terms#team-boards`} target="_blank" rel="noreferrer">terms</a>.</p>
      </section>
      <p className="mem-foot">Every invite, role change, removal, and deleted card is written to the <button type="button" className="linkish" onClick={onAudit}>audit log</button>, with who did it and when.</p>
    </>
  );
}

// ---------- audit log ----------

const ACTIONS: Record<AuditAction, string> = {
  invite_sent: "Invite sent",
  invite_resent: "Invite resent with a new link",
  invite_accepted: "Invite accepted",
  invite_declined: "Invite declined",
  invite_revoked: "Invite revoked",
  invite_expired: "Expired invite link tried",
  role_changed: "Role changed",
  member_removed: "Member removed",
  member_left: "Member left the board",
  sharing_suspended: "Sharing paused: Pro lapsed, members are view only",
  sharing_restored: "Sharing restored: Pro is back, roles apply again",
  card_deleted: "Card deleted",
  card_restored: "Card brought back",
};
/** How a card entry was made when it wasn't by hand. */
const VIA: Record<NonNullable<NonNullable<AuditEntry["detail"]>["via"]>, string> = {
  assistant: "through the assistant", agent: "by their agent, over MCP", undo: "with Undo", redo: "with Redo",
};
const AUDIT_PAGE = 25;

function AuditLog({ me }: { me: Props["me"] }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (before: number | null) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(api(`/api/board/audit?limit=${AUDIT_PAGE}${before ? `&before=${before}` : ""}`), { headers: { Accept: "application/json" } });
      const data = (await r.json().catch(() => null)) as { entries?: AuditEntry[]; next?: number | null } | null;
      if (!r.ok || !Array.isArray(data?.entries)) throw new Error(r.status === 401 ? SIGNED_OUT : "The audit log didn't load. Try again in a minute.");
      const page = data.entries;
      setEntries((have) => (before && have ? [...have, ...page] : page));
      setNext(data.next ?? null);
    } catch (e) {
      setError(e instanceof TypeError ? OFFLINE : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { void load(null); }, [load]);
  // Something just changed on the board: show it, unless older pages are open, where
  // reloading would throw away the reader's place. Refresh is right there for that.
  const changed = useSyncExternalStore(subscribeChanges, () => changes);
  const paged = useRef(false);
  useEffect(() => { if (changed > 0 && !paged.current) void load(null); }, [changed, load]);

  // A resend only records a `from` when the role changed with it (reissue in src/members.ts).
  const role = (e: AuditEntry) => (e.action === "invite_resent" && !e.from && e.to ? `${e.to} (unchanged)` : e.from || e.to ? `${e.from ?? "none"} → ${e.to ?? "none"}` : "");
  return (
    <>
      <p className="mem-summary">
        Who was invited, who accepted or declined, every role change, removal, and exit, when your plan paused or
        restored sharing, and every card deleted from this board since it was first shared: who deleted it, its
        title, and the lane it was in. Newest first. The log can't be edited or cleared, and it's kept as long as
        the account is.
      </p>
      <div className="mem-actions audit-actions">
        <a className="btn" href={api("/api/board/audit.csv")} download>Download CSV</a>
        <a className="btn" href={api("/api/board/audit.json")} download>Download JSON</a>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => { paged.current = false; void load(null); }}>Refresh</button>
        <span className="mem-foot">Downloads hold the whole log, oldest first, numbered from 1 with no gaps, with times in UTC (ISO 8601).</span>
      </div>
      {error && <p className="mem-error" role="alert">{error}</p>}
      {!entries && !error && <p className="mem-loading">loading the audit log</p>}
      {entries && entries.length === 0 && (
        <p className="mem-empty">Nothing here yet. The first entry shows up when you invite someone.</p>
      )}
      {entries && entries.length > 0 && (
        <table className="audit">
          <caption className="sr-only">Audit log, newest first</caption>
          <thead>
            <tr><th scope="col">When</th><th scope="col">Who did it</th><th scope="col">What</th><th scope="col">To whom or what</th><th scope="col">Role change</th></tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td data-th="When">
                  <time dateTime={iso(e.at)}>{stampSeconds(e.at)}</time>
                  <span className="audit-utc">{iso(e.at)}</span>
                  <span className="audit-utc">entry {e.seq}</span>
                </td>
                <td data-th="Who did it" className="audit-who"><span>{e.actor === "system" ? "system (plan change)" : e.actor}{e.actor === me.email && <span className="audit-you"> (you)</span>}</span></td>
                <td data-th="What"><span>{ACTIONS[e.action] ?? e.action}{e.detail?.via ? ` ${VIA[e.detail.via]}` : ""}</span><span className="audit-code">{e.action}</span></td>
                {e.detail ? (
                  <td data-th="Card" className="audit-card"><span>“{e.detail.title}”</span><span className="audit-code">{e.detail.lane ? `in ${e.detail.lane} · ` : ""}{e.detail.card}</span></td>
                ) : (
                  <td data-th="To whom" className="audit-who">{e.target ? <span>{e.target}</span> : <span className="audit-none">the whole board</span>}</td>
                )}
                <td data-th="Role" className="audit-role">{role(e) ? <span>{role(e)}</span> : <span className="audit-none">{e.detail ? "none" : "no change"}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {entries && entries.length > 0 && (
        <div className="mem-actions">
          {next
            ? <button type="button" className="btn" disabled={busy} onClick={() => { paged.current = true; void load(next); }}>{busy ? "Loading…" : "Show older entries"}</button>
            : <span className="mem-foot">That's the whole log: {entries.length} {entries.length === 1 ? "entry" : "entries"}.</span>}
          {next && <span className="mem-foot">Showing the newest {entries.length}.</span>}
        </div>
      )}
    </>
  );
}
