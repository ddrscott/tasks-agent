// Team boards: a Pro owner invites people into their board by email, each as a viewer or a
// writer. This file holds the one answer to "may this user do this on that board" (`access`),
// the invite and membership API, the invite email, and the audit log. The rules themselves are
// in member-rules.ts; the board's Durable Object (agent.ts) enforces them on every change.
//
// There is no other way in: no public link, no "anyone with the link", and a board's id opens
// nothing by itself. Every surface that reaches someone else's board calls `access` first, and
// answers "no such board" and "not your board" the same way.

import { waitUntil } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { currentUser, randomToken, sha256, spendGuess, userIdFor, type User } from "./auth";
import { canManage, planFor } from "./billing";
import {
  BOARD_ID, decide, inviteEmail, isMemberRole, memberCap, MEMBER_HTTP_RATE, retryAfter, SIGNAL_WAITS_MS, SLOW_DOWN_HTTP, spendToken, withRetries,
  type Access, type Bucket, type MemberRole,
} from "./member-rules";

export type { Access, MemberRole } from "./member-rules";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** How long an invite link works. */
export const INVITE_TTL_MS = 7 * DAY_MS;
// Tries at opening, accepting, or declining an invite link. A token is 256 random bits, so
// these aren't what keeps guessing out; they keep the endpoint from being hammered and stop
// anyone from using it to test addresses.
const LOOKUPS_PER_USER_PER_HOUR = 30;
const LOOKUPS_PER_IP_PER_HOUR = 120;

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};
/** People on one board, pending invites included. */
export const maxMembers = (env: Env) => memberCap((env as { MAX_BOARD_MEMBERS?: string }).MAX_BOARD_MEMBERS);
/** Invite emails one owner may send in a UTC day, resends included, so an account can't be used to send spam. */
export const maxDailyInvites = (env: Env) => num((env as { MAX_DAILY_INVITE_EMAILS?: string }).MAX_DAILY_INVITE_EMAILS, 20);

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const fail = (status: number, code: string, error: string) => json({ error, code }, status);

/** One refusal for a bad token, a used one, an expired one, a revoked one, and one meant for another account. */
const INVITE_INVALID = "This invite isn't for this account, or it's no longer valid.";
const inviteInvalid = () => fail(404, "invite_invalid", INVITE_INVALID);

const tokenHash = (token: string) => sha256(`invite:${token}`);

// ---------- how often someone may ask about a board that isn't theirs ----------

// Per signed-in account, in this isolate's memory, spent before the membership lookup: a
// refusal costs no D1 read and wakes no board. It's the first of two limits. Memory is per
// isolate, and Cloudflare may run several, so this one is a floor on the work and not an
// exact count; a member's downloads are counted exactly by the board itself (TodoAgent.fileFor).
const boardCalls = new Map<string, Bucket>();
const BOARD_CALLS_KEPT = 5000;

/** The 429 for a caller past their allowance. The same for a member, a stranger, and a made-up board. */
export function tooFast(seconds: number): Response {
  return Response.json({ error: SLOW_DOWN_HTTP, code: "slow_down" }, { status: 429, headers: { "Retry-After": String(seconds), "Cache-Control": "no-store" } });
}

/**
 * Count one HTTP call this account makes about a board that isn't its own. Null when it may
 * go on, or the 429 to send back. Call it before `access`, so a refused call does no more
 * work than reading the session did.
 */
export function spendBoardCall(userId: string): Response | null {
  const now = Date.now();
  if (boardCalls.size >= BOARD_CALLS_KEPT) {
    // Anyone quiet for long enough to be full again loses nothing by being forgotten.
    const full = (MEMBER_HTTP_RATE.burst / MEMBER_HTTP_RATE.perSecond) * 1000;
    for (const [id, b] of boardCalls) if (now - b.at > full) boardCalls.delete(id);
    if (boardCalls.size >= BOARD_CALLS_KEPT) boardCalls.clear();
  }
  const r = spendToken(boardCalls.get(userId), now, MEMBER_HTTP_RATE);
  boardCalls.set(userId, r.bucket);
  return r.ok ? null : tooFast(retryAfter(r.bucket));
}

// ---------- access ----------

type MemberRow = {
  owner_id: string; owner_email: string; member_email: string; member_id: string; role: MemberRole;
  status: "pending" | "accepted"; token_hash: string | null; used_token_hash: string | null; expires_at: number | null;
  invited_at: number; accepted_at: number | null; updated_at: number;
};

const none = (board: string): Access => ({ board, ownerEmail: null, role: null, effective: "none", reason: "not_member", plan: "free" });

/**
 * May `user` reach the board `ownerId`, and as what. The one function every surface asks: the
 * board socket, attachments, and the board's own Durable Object before each change a member
 * makes.
 *
 * - The owner is the owner, whatever their plan.
 * - A member needs an accepted invite for the email they're signed in as. With the owner off
 *   Pro they're a viewer (`plan_lapsed`); on an encrypted board they have no way in.
 * - Everyone else, and every id that names no board, gets the same `none`.
 *
 * `known.sealed` is for the Durable Object, which already knows whether its board is encrypted.
 */
export async function access(env: Env, user: User, ownerId: string, known?: { sealed: boolean }): Promise<Access> {
  if (typeof ownerId !== "string" || !BOARD_ID.test(ownerId)) return none(String(ownerId).slice(0, 32));
  if (user.id === ownerId) {
    return { board: ownerId, ownerEmail: user.email, ...decide({ isOwner: true, membership: null, plan: "free", sealed: false }), plan: await planFor(env, ownerId) };
  }
  const row = await env.DB.prepare(
    "SELECT role, owner_email, member_email FROM board_members WHERE owner_id = ? AND member_id = ? AND status = 'accepted'",
  ).bind(ownerId, user.id).first<Pick<MemberRow, "role" | "owner_email" | "member_email">>();
  // The id is a hash of the email, so these agree unless something is badly wrong. Check anyway.
  if (!row || row.member_email !== user.email) return none(ownerId);
  const plan = await planFor(env, ownerId);
  const sealed = known ? known.sealed : await (await getAgentByName(env.TodoAgent, ownerId)).isSealed();
  const d = decide({ isOwner: false, membership: row.role, plan, sealed });
  if (d.effective === "none") return { ...none(ownerId), role: d.role, reason: d.reason };
  return { board: ownerId, ownerEmail: row.owner_email, ...d, plan };
}

/** Whether this email holds a live invite or a membership, which lets it sign in past ALLOWED_EMAILS. */
export async function hasInvite(env: Env, email: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 AS ok FROM board_members WHERE member_id = ? AND member_email = ? AND (status = 'accepted' OR expires_at > ?) LIMIT 1",
  ).bind(await userIdFor(email), email, Date.now()).first<{ ok: number }>();
  return !!row;
}

/** Whether a board has anyone on it or invited to it. Such a board can't be encrypted. */
export async function boardShared(env: Env, ownerId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS ok FROM board_members WHERE owner_id = ? LIMIT 1").bind(ownerId).first<{ ok: number }>();
  return !!row;
}

/** What the `detail` column holds for a row the board took off because it was encrypted. */
const ENCRYPTED_DETAIL = JSON.stringify({ why: "encrypted" });
const whyOf = (raw: string | null): "encrypted" | undefined => {
  if (!raw) return undefined;
  try { return (JSON.parse(raw) as { why?: unknown }).why === "encrypted" ? "encrypted" : undefined; } catch { return undefined; }
};

/**
 * The safety net for a board that is encrypted and still has members or pending invites on it.
 * That isn't supposed to happen (`TodoAgent.inviteGate`), and while it lasts nobody but the
 * owner gets in: access is refused on an encrypted board, and an invite to one can't be
 * accepted. This is what keeps turning encryption off from letting them in after all. The
 * board's Durable Object calls it from `disableEncryption`, before the board is readable
 * again: every row comes off, each with an audit entry, `invite_revoked` or `member_removed`
 * by `system`, marked `why: "encrypted"` ("removed: the board was encrypted"). The entries and
 * the delete are one D1 transaction, so nothing is removed without being written down.
 * Returns how many rows it took off.
 *
 * Removing was picked over refusing to decrypt until the owner clears the list: an owner can
 * always decrypt this way, and anyone who should be on the board can be invited again.
 */
export async function clearSealedSharing(env: Env, ownerId: string): Promise<number> {
  const [, gone] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO board_audit (owner_id, at, actor, action, target, from_role, to_role, detail)
       SELECT owner_id, ?2, 'system', CASE status WHEN 'pending' THEN 'invite_revoked' ELSE 'member_removed' END, member_email, role, NULL, ?3
       FROM board_members WHERE owner_id = ?1 ORDER BY invited_at`,
    ).bind(ownerId, Date.now(), ENCRYPTED_DETAIL),
    env.DB.prepare("DELETE FROM board_members WHERE owner_id = ?").bind(ownerId),
  ]);
  return gone.meta.changes ?? 0;
}

// ---------- audit log ----------

export type AuditAction =
  | "invite_sent" | "invite_resent" | "invite_accepted" | "invite_declined" | "invite_revoked" | "invite_expired"
  | "role_changed" | "member_removed" | "member_left" | "sharing_suspended" | "sharing_restored"
  | "card_deleted" | "card_restored";

/** What a card entry says about the card: its id, its title and lane at that moment, and how it was done when not by hand. */
export type AuditCard = { card: string; title: string; lane: string; via?: "assistant" | "agent" | "undo" | "redo" };

export type AuditEntry = {
  /** The row's id in the whole table, for paging (`before`). It has gaps: other boards' entries sit between. */
  id: number;
  /** This board's own count, 1 for its first entry and no gaps. It never changes: the log is append-only. Exports use it. */
  seq: number;
  /** When, as epoch milliseconds, and the same instant as ISO-8601 in UTC. */
  at: number; time: string;
  actor: string; action: AuditAction; target: string | null; from: MemberRole | null; to: MemberRole | null;
  /** Set on `card_deleted` and `card_restored`, null on membership entries. */
  detail: AuditCard | null;
  /**
   * Set when `actor` did it as a site admin and not as someone on the board: giving or taking
   * back Pro on the admin page, which pauses or restores sharing. Left off every other entry.
   */
  actorRole?: "admin";
  /** Set on an invite or a member the board itself took off because it was encrypted (`clearSealedSharing`). */
  why?: "encrypted";
};

function auditRow(env: Env, ownerId: string, actor: string, action: AuditAction, target: string | null, from: MemberRole | null = null, to: MemberRole | null = null) {
  return env.DB.prepare("INSERT INTO board_audit (owner_id, at, actor, action, target, from_role, to_role) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(ownerId, Date.now(), actor, action, target, from, to);
}

const audit = (...args: Parameters<typeof auditRow>) => auditRow(...args).run();

/** What the `detail` column holds for an entry an admin made: no card, only that the actor was acting as an admin. */
const ADMIN_DETAIL = JSON.stringify({ actorRole: "admin" });
const byAdmin = (raw: string | null): boolean => {
  if (!raw) return false;
  try { return (JSON.parse(raw) as { actorRole?: unknown }).actorRole === "admin"; } catch { return false; }
};

type AuditDbRow = { id: number; seq: number; at: number; actor: string; action: AuditAction; target: string | null; from_role: MemberRole | null; to_role: MemberRole | null; detail: string | null };
function cardDetail(raw: string | null): AuditCard | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<AuditCard>;
    if (typeof d.card !== "string" || typeof d.title !== "string") return null;
    const via = d.via === "assistant" || d.via === "agent" || d.via === "undo" || d.via === "redo" ? d.via : undefined;
    return { card: d.card, title: d.title, lane: typeof d.lane === "string" ? d.lane : "", ...(via ? { via } : {}) };
  } catch {
    return null;
  }
}
const toEntry = (r: AuditDbRow): AuditEntry => ({
  id: r.id, seq: r.seq, at: r.at, time: new Date(r.at).toISOString(), actor: r.actor, action: r.action, target: r.target, from: r.from_role, to: r.to_role, detail: cardDetail(r.detail),
  ...(byAdmin(r.detail) ? { actorRole: "admin" as const } : {}),
  ...(whyOf(r.detail) ? { why: whyOf(r.detail) } : {}),
});

/**
 * Write down cards that were deleted from a board, or brought back by undo: who, when, the
 * card's title, and the lane it was in. Only the board's Durable Object calls this, with the
 * name it took from the connection that made the change (TodoAgent.noteCards); there's no
 * route to it, so a member can't write an entry or choose the name on one.
 *
 * A board that was never shared writes nothing: the insert only happens when `board_sharing`
 * has a row, which the first invite creates and nothing deletes. One row per card.
 */
export async function logCards(env: Env, ownerId: string, actor: string, action: "card_deleted" | "card_restored", cards: AuditCard[]): Promise<void> {
  const at = Date.now();
  const rows = cards.map((c) => env.DB.prepare(
    `INSERT INTO board_audit (owner_id, at, actor, action, target, from_role, to_role, detail)
     SELECT ?1, ?2, ?3, ?4, NULL, NULL, NULL, ?5 WHERE EXISTS (SELECT 1 FROM board_sharing WHERE owner_id = ?1)`,
  ).bind(ownerId, at, actor, action, JSON.stringify({ card: c.card, title: c.title.slice(0, 200), lane: c.lane.slice(0, 40), ...(c.via ? { via: c.via } : {}) })));
  for (let i = 0; i < rows.length; i += 50) await env.DB.batch(rows.slice(i, i + 50));
}

/** A spreadsheet runs a cell that starts with = + - or @ as a formula. Emails can start with those. */
function csvCell(v: string | number | null): string {
  let s = v === null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------- telling the board ----------

/**
 * Tell the board's Durable Object that its membership or its owner's plan just changed, so
 * sockets that are already open are closed or downgraded now, and the owner's open tabs read
 * the members list again (TodoAgent.membersChanged). Every change to `board_members` calls
 * it, the ones that change nobody's access too (an invite sent, declined, or revoked): the
 * owner's Members dialog is waiting on those.
 *
 * A try that fails is tried again, four times in all over about three and a half seconds
 * (SIGNAL_WAITS_MS), and the request waits for them: the row is already changed, and the
 * answer shouldn't say "removed" while their tab is still open. The work is handed to
 * `waitUntil` as well, so it finishes even if the caller hangs up. If every try fails it's
 * logged as an error, loudly, and the board's own checks are what's left: writes are refused
 * from the member's next frame regardless (the board asks D1 again within 2 seconds), nothing
 * is pushed to their tab on a check older than MEMBER_PUSH_FRESH_MS (5 seconds), and the sweep
 * closes it within MEMBER_RECHECK_SECONDS (30).
 */
async function signal(env: Env, ownerId: string, left?: string): Promise<void> {
  const work = withRetries(
    // `left` is the member who just left on their own, so the owner's open tabs can say so.
    async () => { await (await getAgentByName(env.TodoAgent, ownerId)).membersChanged(left); },
    SIGNAL_WAITS_MS,
    (e, attempt) => console.warn(`telling the board about a membership change failed (try ${attempt} of ${SIGNAL_WAITS_MS.length})`, (e as Error)?.message),
  ).then(() => undefined, (e: unknown) => {
    console.error(`MEMBERSHIP SIGNAL LOST for board ${ownerId} after ${SIGNAL_WAITS_MS.length} tries: open member tabs keep their old access until the board's own recheck (seconds for reads, up to MEMBER_RECHECK_SECONDS to close).`, (e as Error)?.message);
  });
  try { waitUntil(work); } catch { /* no request to hang it on (a test, a scheduled run): the await below is enough */ }
  await work;
}

/**
 * Write "sharing suspended" or "sharing restored" to the audit log the moment the owner's plan
 * changes what members can do. Nothing is deleted either way. Called by the Stripe webhook, by
 * the admin page's Pro switch, by the board while members are connected, and when the owner
 * opens the members list, so a lapse nobody announced (a missed webhook, a period that ran
 * out) is still written down.
 *
 * Every entry written here is `system`: Stripe, a period that ran out, or a row someone
 * changed some other way. Nothing in this function can put a person's name on a plan change.
 * An admin's name gets onto one in exactly one place, `adminFlip` below, which is the admin's
 * own request changing the grant.
 */
export async function syncSharing(env: Env, ownerId: string): Promise<{ suspended: boolean; flipped: boolean } | null> {
  const row = await env.DB.prepare("SELECT suspended FROM board_sharing WHERE owner_id = ?").bind(ownerId).first<{ suspended: number }>();
  if (!row) return null; // never shared
  const suspended = (await planFor(env, ownerId)) === "pro" ? 0 : 1;
  let flipped = false;
  if (row.suspended !== suspended) {
    // Only the request that flips the row writes the entry.
    const changed = await env.DB.prepare("UPDATE board_sharing SET suspended = ?1, updated_at = ?2 WHERE owner_id = ?3 AND suspended != ?1")
      .bind(suspended, Date.now(), ownerId).run();
    flipped = true;
    if (changed.meta.changes === 1 && (await boardShared(env, ownerId))) {
      await audit(env, ownerId, "system", suspended ? "sharing_suspended" : "sharing_restored", null);
    }
  }
  return { suspended: !!suspended, flipped };
}

/**
 * The one way an admin's name gets onto a plan entry. The admin page's Pro switch (users.ts)
 * runs this statement in the same D1 transaction as its write to `users.pro_grant`, ahead of
 * it, when that write is about to change what the owner's plan is. It flips the board's
 * sharing row only if the grant really is changing (`grant` is the new value, compared with
 * the stored one right here) and the row isn't already where it's going. The admin's request
 * then reads back whether this statement changed a row, and writes the entry in their name
 * only if it did (`logAdminFlip`).
 *
 * So the name is never a guess. Nobody else can see the new grant before the row is flipped,
 * because both land together, and a request that didn't change the grant in that direction
 * (a role-only edit, a switch set to what it already was, anything Stripe did) can't flip the
 * row here and so can't be named. Before this, any plan entry was put down to whichever admin
 * had touched the account in the last ten seconds.
 */
export function adminFlip(env: Env, ownerId: string, suspended: 0 | 1, grant: 0 | 1, at: number): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE board_sharing SET suspended = ?1, updated_at = ?2
     WHERE owner_id = ?3 AND suspended != ?1 AND COALESCE((SELECT pro_grant FROM users WHERE user_id = ?3), 0) != ?4`,
  ).bind(suspended, at, ownerId, grant);
}

/** Write the entry for a flip `adminFlip` just made: the admin's email as the actor, marked as an admin's doing. */
export async function logAdminFlip(env: Env, ownerId: string, admin: string, suspended: 0 | 1): Promise<void> {
  if (!(await boardShared(env, ownerId))) return;
  await env.DB.prepare("INSERT INTO board_audit (owner_id, at, actor, action, target, from_role, to_role, detail) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)")
    .bind(ownerId, Date.now(), admin, suspended ? "sharing_suspended" : "sharing_restored", ADMIN_DETAIL).run();
}

/**
 * The owner's plan just changed: Stripe's webhook stored a subscription (billing.ts), or an
 * admin gave or took back Pro (users.ts, which has already recorded its own flip). Record
 * anything still unrecorded, as `system`, and tell the open sockets.
 */
export async function planChanged(env: Env, ownerId: string): Promise<void> {
  if ((await syncSharing(env, ownerId)) !== null) return signal(env, ownerId);
  // A board nobody was ever invited to has no members to recheck and nothing to log, but its
  // owner may have it open, with a menu that still says "Upgrade to Pro". One try, no retries:
  // the tab asks again by itself the next time it has a reason to.
  await (await getAgentByName(env.TodoAgent, ownerId)).planChanged();
}

// ---------- the invite email ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const ROLE_WORDS: Record<MemberRole, string> = { viewer: "a viewer (you can read it, not change it)", writer: "a writer (you can add, edit, and move cards)" };

function inviteLink(req: Request, token: string): string {
  // The token rides in the fragment, which browsers never send to a server: it stays out of
  // access logs and Referer headers. The page reads it and posts it to /api/invites/*.
  return `${new URL(req.url).origin}/tasks/invite#t=${token}`;
}

/**
 * Send the invite, or in dev (DEV_LOGIN_CODES=1) print it and hand the link back, the same way
 * sign-in codes work there. In production the link only ever goes to the invited mailbox.
 */
async function sendInvite(req: Request, env: Env, owner: User, email: string, role: MemberRole, token: string, expiresAt: number): Promise<{ devLink?: string } | { error: string }> {
  const link = inviteLink(req, token);
  if (env.DEV_LOGIN_CODES === "1") {
    console.log(`[dev] invite for ${email} to ${owner.email}'s board (${role}): ${link}`);
    return { devLink: link };
  }
  const until = new Date(expiresAt).toISOString().slice(0, 10);
  const text = `${owner.email} invited you to their Tasks board as ${ROLE_WORDS[role]}.\n\nOpen the invite:\n${link}\n\n`
    + `Sign in as ${email} to accept or decline. The link works once and expires on ${until} (7 days).\n\n`
    + "If you weren't expecting this, you can ignore this email. Nothing is shared with you unless you accept.";
  const html = `<!doctype html><html><body style="margin:0;background:#f7f6f3;font-family:-apple-system,Segoe UI,Inter,sans-serif;color:#2c2c2c">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px">
<table width="100%" style="max-width:440px;background:#fffef9;border:2px solid #2c2c2c" cellpadding="0" cellspacing="0"><tr><td style="padding:32px">
<div style="font-size:24px;font-weight:700;margin-bottom:24px">tasks<span style="color:#E85D00">.</span></div>
<p style="font-size:15px;margin:0 0 16px"><b>${esc(owner.email)}</b> invited you to their Tasks board as ${esc(ROLE_WORDS[role])}.</p>
<a href="${esc(link)}" style="display:inline-block;background:#E85D00;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px">Open the invite</a>
<p style="font-size:13px;color:#6b6b6b;margin:24px 0 0">Sign in as ${esc(email)} to accept or decline. The link works once and expires on ${until} (7 days). If you weren't expecting this, ignore this email. Nothing is shared with you unless you accept.</p>
</td></tr></table></td></tr></table></body></html>`;
  try {
    await env.EMAIL.send({ from: { email: env.EMAIL_FROM, name: "Tasks" }, to: email, subject: `${owner.email} invited you to a Tasks board`, text, html });
    return {};
  } catch (e) {
    console.error("invite email failed", (e as { code?: string }).code, (e as Error).message);
    return { error: "We couldn't send the invite email. Try Resend in a minute." };
  }
}

/** Count one invite email against the owner's day. False when today's are used up. One atomic statement. */
async function spendInviteEmail(env: Env, ownerId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `INSERT INTO invite_sends (owner_id, day, sent) VALUES (?1, ?2, 1)
     ON CONFLICT(owner_id, day) DO UPDATE SET sent = sent + 1 WHERE invite_sends.sent < ?3
     RETURNING sent`,
  ).bind(ownerId, new Date().toISOString().slice(0, 10), maxDailyInvites(env)).first<{ sent: number }>();
  return !!row;
}

// ---------- owner side ----------

export type Member = { email: string; role: MemberRole; status: "pending" | "accepted"; invitedAt: number; acceptedAt: number | null; expiresAt: number | null; expired: boolean };
const toMember = (r: MemberRow): Member => ({
  email: r.member_email, role: r.role, status: r.status, invitedAt: r.invited_at, acceptedAt: r.accepted_at,
  expiresAt: r.status === "pending" ? r.expires_at : null, expired: r.status === "pending" && (r.expires_at ?? 0) <= Date.now(),
});

const rowFor = (env: Env, ownerId: string, email: string) =>
  env.DB.prepare("SELECT * FROM board_members WHERE owner_id = ? AND member_email = ?").bind(ownerId, email).first<MemberRow>();

/**
 * Why the owner can or can't invite right now:
 * `on`, `pro_required` (free plan, nobody invited yet), `suspended` (people are on the board
 * and Pro lapsed: they're view only until it's back), or `encrypted`.
 */
export type Sharing = "on" | "pro_required" | "suspended" | "encrypted";

async function listMembers(env: Env, owner: User): Promise<Response> {
  // Opening the list is also a chance to notice a plan change no webhook announced.
  if ((await syncSharing(env, owner.id))?.flipped) await signal(env, owner.id);
  const { results } = await env.DB.prepare("SELECT * FROM board_members WHERE owner_id = ? ORDER BY invited_at").bind(owner.id).all<MemberRow>();
  const plan = await planFor(env, owner.id);
  const sealed = await (await getAgentByName(env.TodoAgent, owner.id)).isSealed();
  const sent = await env.DB.prepare("SELECT sent FROM invite_sends WHERE owner_id = ? AND day = ?")
    .bind(owner.id, new Date().toISOString().slice(0, 10)).first<{ sent: number }>();
  const sharing: Sharing = sealed ? "encrypted" : plan === "pro" ? "on" : results.length ? "suspended" : "pro_required";
  return json({
    board: {
      id: owner.id, ownerEmail: owner.email, plan, sharing,
      maxMembers: maxMembers(env), used: results.length,
      maxInvitesPerDay: maxDailyInvites(env), invitesToday: sent?.sent ?? 0,
      // Whether there's a Stripe subscription for "Manage subscription" to open (canManage in billing.ts).
      manage: await canManage(env, owner.id),
    },
    members: results.map(toMember),
  });
}

/**
 * Ask the board whether it can take an invite right now (`TodoAgent.inviteGate`), and turn
 * anything but "open" into the refusal. Null when it can.
 */
async function gateRefusal(env: Env, ownerId: string): Promise<Response | null> {
  const gate = await (await getAgentByName(env.TodoAgent, ownerId)).inviteGate();
  if (gate === "open") return null;
  return fail(409, "board_encrypted", gate === "sealed"
    ? "An end-to-end encrypted board can't be shared. Turn encryption off first."
    : "This board is being encrypted right now, and an encrypted board can't be shared. Try again in a moment.");
}

/** What every new invite and resend needs first: Pro, and a board that isn't encrypted or being encrypted. */
async function mayInvite(env: Env, owner: User): Promise<Response | null> {
  if ((await planFor(env, owner.id)) !== "pro") return fail(402, "pro_required", "Sharing a board is part of Pro. Upgrade to invite people.");
  return gateRefusal(env, owner.id);
}

async function setRole(env: Env, owner: User, row: MemberRow, role: MemberRole): Promise<Response> {
  if (row.role !== role) {
    await env.DB.batch([
      env.DB.prepare("UPDATE board_members SET role = ?, updated_at = ? WHERE owner_id = ? AND member_email = ?").bind(role, Date.now(), owner.id, row.member_email),
      auditRow(env, owner.id, owner.email, "role_changed", row.member_email, row.role, role),
    ]);
    await signal(env, owner.id);
  }
  return json({ member: toMember({ ...row, role }), changed: row.role !== role });
}

/** A fresh token on a pending invite, and its email. The old link stops working the moment the hash is replaced. */
async function reissue(req: Request, env: Env, owner: User, row: MemberRow, role: MemberRole): Promise<Response> {
  if (!(await spendInviteEmail(env, owner.id))) return fail(429, "invite_limit", `You've sent today's ${maxDailyInvites(env)} invite emails. Try again tomorrow (UTC).`);
  const token = randomToken();
  const now = Date.now();
  const expiresAt = now + INVITE_TTL_MS;
  const changed = await env.DB.prepare(
    "UPDATE board_members SET token_hash = ?, expires_at = ?, role = ?, updated_at = ? WHERE owner_id = ? AND member_email = ? AND status = 'pending'",
  ).bind(await tokenHash(token), expiresAt, role, now, owner.id, row.member_email).run();
  // Accepted in the meantime: there's nothing to resend.
  if (changed.meta.changes !== 1) return fail(409, "already_member", "They already accepted.");
  await audit(env, owner.id, owner.email, "invite_resent", row.member_email, row.role !== role ? row.role : null, role);
  await signal(env, owner.id);
  const sent = await sendInvite(req, env, owner, row.member_email, role, token, expiresAt);
  const member = toMember({ ...row, role, expires_at: expiresAt });
  if ("error" in sent) return json({ error: sent.error, code: "email_failed", member }, 502);
  return json({ member, ...sent });
}

async function invite(req: Request, env: Env, owner: User, body: Record<string, unknown>): Promise<Response> {
  const email = inviteEmail(body.email);
  if (!email) return fail(400, "bad_email", "That doesn't look like an email address we can invite. Use plain letters, digits, and punctuation.");
  if (!isMemberRole(body.role)) return fail(400, "bad_role", "Pick viewer or writer.");
  const role = body.role;
  if (email === owner.email) return fail(400, "self", "That's you. You already own this board.");
  const refused = await mayInvite(env, owner);
  if (refused) return refused;

  const existing = await rowFor(env, owner.id, email);
  // Inviting someone who's already on the board changes their role, or does nothing. No email.
  if (existing?.status === "accepted") return setRole(env, owner, existing, role);
  if (existing) return reissue(req, env, owner, existing, role);

  const max = maxMembers(env);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM board_members WHERE owner_id = ?").bind(owner.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= max) {
    // Both caps can be hit at once. The full board leads, because it's the one the owner can
    // do something about right now, and the answer says the day's emails are gone as well, so
    // they don't make room only to be turned away again.
    const sent = await env.DB.prepare("SELECT sent FROM invite_sends WHERE owner_id = ? AND day = ?")
      .bind(owner.id, new Date().toISOString().slice(0, 10)).first<{ sent: number }>();
    const spent = (sent?.sent ?? 0) >= maxDailyInvites(env);
    return json({
      error: `A board can have ${max} people, pending invites included. Remove someone or revoke an invite first.`
        + (spent ? ` Today's ${maxDailyInvites(env)} invite emails are used up too, so a new invite also has to wait until tomorrow (UTC).` : ""),
      code: "member_limit", ...(spent ? { also: ["invite_limit"] } : {}),
    }, 409);
  }
  if (!(await spendInviteEmail(env, owner.id))) return fail(429, "invite_limit", `You've sent today's ${maxDailyInvites(env)} invite emails. Try again tomorrow (UTC).`);

  const token = randomToken();
  const now = Date.now();
  const expiresAt = now + INVITE_TTL_MS;
  // The cap is checked again inside the insert, so two invites racing can't both squeeze past it.
  const added = await env.DB.prepare(
    `INSERT INTO board_members (owner_id, owner_email, member_email, member_id, role, status, token_hash, expires_at, invited_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8, ?8
     WHERE (SELECT COUNT(*) FROM board_members WHERE owner_id = ?1) < ?9
     ON CONFLICT(owner_id, member_email) DO NOTHING`,
  ).bind(owner.id, owner.email, email, await userIdFor(email), role, await tokenHash(token), expiresAt, now, max).run();
  if (added.meta.changes !== 1) return fail(409, "member_limit", `A board can have ${max} people, pending invites included. Remove someone or revoke an invite first.`);
  // The row is in. Now the board is asked again, and its answer is the one that counts
  // (TodoAgent.inviteGate): `mayInvite` asked before the awaits above, and the board can have
  // started encrypting since. Anything but "open", or no answer at all, and the row comes back
  // out before anyone hears of it: no audit entry, no email, and the day's count is handed back.
  const refusedNow = await gateRefusal(env, owner.id).catch((e: Error) => {
    console.error("confirming an invite with the board failed", e.message);
    return fail(503, "try_again", "Couldn't reach the board to confirm the invite, so it wasn't sent. Try again in a moment.");
  });
  if (refusedNow) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM board_members WHERE owner_id = ? AND member_email = ? AND status = 'pending' AND token_hash = ?").bind(owner.id, email, await tokenHash(token)),
      env.DB.prepare("UPDATE invite_sends SET sent = sent - 1 WHERE owner_id = ? AND day = ? AND sent > 0").bind(owner.id, new Date(now).toISOString().slice(0, 10)),
    ]);
    return refusedNow;
  }
  await env.DB.batch([
    auditRow(env, owner.id, owner.email, "invite_sent", email, null, role),
    env.DB.prepare("INSERT OR IGNORE INTO board_sharing (owner_id, suspended, updated_at) VALUES (?, 0, ?)").bind(owner.id, now),
  ]);
  // From the first invite on, the board writes down who deletes a card (membersChanged marks it
  // shared), and the owner's other tabs hear there's someone new on the list.
  await signal(env, owner.id);
  const sent = await sendInvite(req, env, owner, email, role, token, expiresAt);
  const member: Member = { email, role, status: "pending", invitedAt: now, acceptedAt: null, expiresAt, expired: false };
  if ("error" in sent) return json({ error: sent.error, code: "email_failed", member }, 502);
  return json({ member, ...sent }, 201);
}

async function resend(req: Request, env: Env, owner: User, body: Record<string, unknown>): Promise<Response> {
  const email = inviteEmail(body.email);
  const row = email ? await rowFor(env, owner.id, email) : null;
  if (!row || row.status !== "pending") return fail(404, "not_found", "There's no pending invite for that address.");
  const refused = await mayInvite(env, owner);
  if (refused) return refused;
  return reissue(req, env, owner, row, row.role);
}

/** Take back a pending invite (`revoke`) or take an accepted member off the board (`remove`). */
async function drop(env: Env, owner: User, body: Record<string, unknown>, status: "pending" | "accepted"): Promise<Response> {
  const email = inviteEmail(body.email);
  const gone = email ? await env.DB.prepare("DELETE FROM board_members WHERE owner_id = ? AND member_email = ? AND status = ? RETURNING role")
    .bind(owner.id, email, status).first<{ role: MemberRole }>() : null;
  if (!gone) return fail(404, "not_found", status === "pending" ? "There's no pending invite for that address." : "Nobody with that address is on this board.");
  await audit(env, owner.id, owner.email, status === "pending" ? "invite_revoked" : "member_removed", email, gone.role, null);
  // Their open tabs lose the board before this request answers.
  await signal(env, owner.id);
  return json({ ok: true });
}

async function changeRole(env: Env, owner: User, body: Record<string, unknown>): Promise<Response> {
  const email = inviteEmail(body.email);
  if (!isMemberRole(body.role)) return fail(400, "bad_role", "Pick viewer or writer.");
  const row = email ? await rowFor(env, owner.id, email) : null;
  if (!row) return fail(404, "not_found", "Nobody with that address is on this board.");
  return setRole(env, owner, row, body.role);
}

const AUDIT_PAGE = 50;
const AUDIT_EXPORT_MAX = 50_000;

/** The two kinds of entry the audit tab can be narrowed to. */
const AUDIT_KINDS = ["membership", "cards"] as const;

/**
 * One page of the log, newest first. `who` narrows it to entries a person made or that were
 * made about them (actor or target), and `kind` to membership entries or card deletions. The
 * filter is here and not in the browser because the log is paged: filtering 25 loaded entries
 * would hide matches on the pages not loaded yet. `seq` is still the entry's number in the
 * whole log. The first page also lists everyone who appears in the log, for the filter.
 */
async function auditPage(req: Request, env: Env, owner: User): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const before = Number(q.get("before"));
  const limit = Math.min(200, num(q.get("limit") ?? undefined, AUDIT_PAGE));
  const who = (q.get("who") ?? "").trim().toLowerCase().slice(0, 254);
  const kind = (AUDIT_KINDS as readonly string[]).includes(q.get("kind") ?? "") ? q.get("kind")! : "";
  const first = !(Number.isInteger(before) && before > 0);
  const { results } = await env.DB.prepare(
    `SELECT id, (SELECT COUNT(*) FROM board_audit b WHERE b.owner_id = a.owner_id AND b.id <= a.id) AS seq, at, actor, action, target, from_role, to_role, detail
     FROM board_audit a WHERE owner_id = ?1 AND (?2 = 0 OR id < ?2)
       AND (?4 = '' OR actor = ?4 OR target = ?4)
       AND (?5 = '' OR (?5 = 'cards') = (action IN ('card_deleted', 'card_restored')))
     ORDER BY id DESC LIMIT ?3`,
  ).bind(owner.id, first ? 0 : before, limit + 1, who, kind).all<AuditDbRow>();
  const page = results.slice(0, limit);
  const people = first ? (await env.DB.prepare(
    "SELECT actor AS p FROM board_audit WHERE owner_id = ?1 UNION SELECT target FROM board_audit WHERE owner_id = ?1 AND target IS NOT NULL ORDER BY p LIMIT 500",
  ).bind(owner.id).all<{ p: string }>()).results.map((r) => r.p) : undefined;
  return json({ entries: page.map(toEntry), next: results.length > limit ? page[page.length - 1].id : null, ...(people ? { people } : {}) });
}

async function auditExport(env: Env, owner: User, format: "csv" | "json"): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS seq, at, actor, action, target, from_role, to_role, detail FROM board_audit WHERE owner_id = ? ORDER BY id LIMIT ?",
  ).bind(owner.id, AUDIT_EXPORT_MAX).all<AuditDbRow>();
  const name = `tasks-audit-${new Date().toISOString().slice(0, 10)}.${format}`;
  const headers = { "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (format === "json") {
    // The table's own row id stays out of a download: it counts every board's entries, so one
    // board's would show gaps that look like missing rows. `seq` is this board's 1..N.
    const entries = results.map(toEntry).map(({ id: _, ...e }) => e);
    return new Response(JSON.stringify({ board: owner.id, owner: owner.email, exportedAt: new Date().toISOString(), entries }, null, 2),
      { headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
  }
  const lines = ["seq,time,actor,action,target,from_role,to_role,card_id,card_title,lane,via"];
  for (const r of results) {
    const d = cardDetail(r.detail);
    lines.push([r.seq, new Date(r.at).toISOString(), r.actor, r.action, r.target, r.from_role, r.to_role, d?.card ?? null, d?.title ?? null, d?.lane ?? null, d?.via ?? (byAdmin(r.detail) ? "admin" : whyOf(r.detail) ? "board encrypted" : null)].map(csvCell).join(","));
  }
  // The byte-order mark is what tells Excel on Windows the file is UTF-8 when it's opened with
  // a double-click; without it, a card title that isn't plain ASCII comes out garbled.
  return new Response(`\uFEFF${lines.join("\r\n")}\r\n`, { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" } });
}

// ---------- invitee side ----------

/** Spend one try from this account's and this address's hourly budget for invite links. */
async function withinLookups(req: Request, env: Env, user: User): Promise<boolean> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  return (await spendGuess(env, `invite-ip:${ip}`, LOOKUPS_PER_IP_PER_HOUR, HOUR_MS))
    && (await spendGuess(env, `invite-user:${user.id}`, LOOKUPS_PER_USER_PER_HOUR, HOUR_MS));
}

const tooMany = () => fail(429, "too_many", "Too many tries at invite links. Wait a while and try again.");

/** The pending invite a token names, but only for the account it was sent to and only while it's live. */
async function liveInvite(env: Env, user: User, token: unknown): Promise<MemberRow | null> {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  // Looked up by the token's SHA-256, so nothing is compared byte by byte against a secret.
  const row = await env.DB.prepare("SELECT * FROM board_members WHERE token_hash = ?").bind(await tokenHash(token)).first<MemberRow>();
  if (!row || row.status !== "pending" || row.member_email !== user.email) return null;
  if ((row.expires_at ?? 0) <= Date.now()) {
    // Used too late. Kill the token so it's written down once, and leave the invite for the owner to resend.
    const killed = await env.DB.prepare("UPDATE board_members SET token_hash = NULL, updated_at = ? WHERE owner_id = ? AND member_email = ? AND token_hash = ?")
      .bind(Date.now(), row.owner_id, row.member_email, row.token_hash).run();
    if (killed.meta.changes === 1) await audit(env, row.owner_id, user.email, "invite_expired", row.member_email, row.role, null);
    return null;
  }
  return row;
}

/**
 * The board a spent token let this very account onto, if they're still on it. For the person
 * who opens their invite email a second time. It answers only for the signed-in member the
 * token was used by (their id and their email, on a row that's still accepted), so it tells
 * nobody anything they couldn't already see in their own board list: a stranger holding the
 * same link, another account, and the same person after leaving or being removed all get
 * nothing here, and so the one generic refusal. It's a read. Nothing about the token changes.
 */
async function usedByMe(env: Env, user: User, token: unknown): Promise<Pick<MemberRow, "owner_id" | "owner_email" | "role"> | null> {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return env.DB.prepare(
    "SELECT owner_id, owner_email, role FROM board_members WHERE used_token_hash = ? AND member_id = ? AND member_email = ? AND status = 'accepted'",
  ).bind(await tokenHash(token), user.id, user.email).first<Pick<MemberRow, "owner_id" | "owner_email" | "role">>();
}

async function lookup(req: Request, env: Env, user: User, body: Record<string, unknown>): Promise<Response> {
  if (!(await withinLookups(req, env, user))) return tooMany();
  const row = await liveInvite(env, user, body.token);
  if (!row) {
    const mine = await usedByMe(env, user, body.token);
    return mine ? json({ member: { board: mine.owner_id, ownerEmail: mine.owner_email, role: mine.role } }) : inviteInvalid();
  }
  return json({ invite: { board: row.owner_id, ownerEmail: row.owner_email, email: row.member_email, role: row.role, expiresAt: row.expires_at } });
}

async function accept(req: Request, env: Env, user: User, body: Record<string, unknown>): Promise<Response> {
  if (!(await withinLookups(req, env, user))) return tooMany();
  const row = await liveInvite(env, user, body.token);
  if (!row) return inviteInvalid();
  // An invite to a board that's encrypted now can't be accepted. There shouldn't be one
  // (TodoAgent.inviteGate); if there is, it stays pending until the owner revokes it or turns
  // encryption off, which takes it away (clearSealedSharing). Only the invited account, with
  // the link, gets this far, so saying why tells nobody anything about a board they weren't asked to.
  const gate = await (await getAgentByName(env.TodoAgent, row.owner_id)).inviteGate();
  if (gate !== "open") {
    return fail(409, "board_encrypted", gate === "sealed"
      ? "This board is end-to-end encrypted now, so nobody can join it. Ask its owner to turn encryption off and invite you again."
      : "This board is being encrypted right now, so nobody can join it. Try again in a moment.");
  }
  const now = Date.now();
  // Single use: the token's hash is cleared in the same statement that accepts, so of two
  // requests racing with one link, one changes a row and the other finds nothing.
  const used = await env.DB.prepare(
    `UPDATE board_members SET status = 'accepted', used_token_hash = token_hash, token_hash = NULL, expires_at = NULL, accepted_at = ?1, updated_at = ?1
     WHERE token_hash = ?2 AND status = 'pending' AND member_email = ?3 AND member_id = ?4 AND expires_at > ?1`,
  ).bind(now, row.token_hash, user.email, user.id).run();
  if (used.meta.changes !== 1) return inviteInvalid();
  await audit(env, row.owner_id, user.email, "invite_accepted", user.email, null, row.role);
  await signal(env, row.owner_id);
  return json({ ok: true, board: { id: row.owner_id, ownerEmail: row.owner_email, role: row.role } });
}

async function decline(req: Request, env: Env, user: User, body: Record<string, unknown>): Promise<Response> {
  if (!(await withinLookups(req, env, user))) return tooMany();
  const row = await liveInvite(env, user, body.token);
  if (!row) return inviteInvalid();
  const gone = await env.DB.prepare("DELETE FROM board_members WHERE token_hash = ? AND status = 'pending' AND member_email = ?")
    .bind(row.token_hash, user.email).run();
  if (gone.meta.changes !== 1) return inviteInvalid();
  await audit(env, row.owner_id, user.email, "invite_declined", user.email, row.role, null);
  await signal(env, row.owner_id);
  return json({ ok: true });
}

export type SharedBoard = { board: string; ownerEmail: string; role: MemberRole; effective: "viewer" | "writer"; reason: null | "plan_lapsed"; plan: "free" | "pro"; since: number | null };

async function boards(env: Env, user: User): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT owner_id, owner_email, role, accepted_at FROM board_members WHERE member_id = ? AND member_email = ? AND status = 'accepted' ORDER BY accepted_at LIMIT 50",
  ).bind(user.id, user.email).all<Pick<MemberRow, "owner_id" | "owner_email" | "role" | "accepted_at">>();
  const shared: SharedBoard[] = [];
  for (const r of results) {
    const plan = await planFor(env, r.owner_id);
    // An encrypted board can't have members, so there's no need to wake each board to ask.
    const d = decide({ isOwner: false, membership: r.role, plan, sealed: false });
    shared.push({ board: r.owner_id, ownerEmail: r.owner_email, role: r.role, effective: d.effective as "viewer" | "writer", reason: d.reason as null | "plan_lapsed", plan, since: r.accepted_at });
  }
  return json({ own: { board: user.id, email: user.email, plan: await planFor(env, user.id) }, shared });
}

async function leave(env: Env, user: User, body: Record<string, unknown>): Promise<Response> {
  const board = typeof body.board === "string" && BOARD_ID.test(body.board) ? body.board : null;
  const gone = board ? await env.DB.prepare("DELETE FROM board_members WHERE owner_id = ? AND member_id = ? AND member_email = ? AND status = 'accepted' RETURNING role")
    .bind(board, user.id, user.email).first<{ role: MemberRole }>() : null;
  // The same answer for a board that isn't there and one you were never on.
  if (!board || !gone) return fail(404, "not_found", "You're not on that board.");
  await audit(env, board, user.email, "member_left", user.email, gone.role, null);
  await signal(env, board, user.email);
  return json({ ok: true });
}

/**
 * The team-board API. Everything needs a browser session; the Worker has already refused
 * writes from another origin (fromElsewhere in server.ts). `/api/board/*` is the signed-in
 * user's own board, so there's no board id to pass and none to guess.
 */
export async function handleMembers(req: Request, env: Env, path: string): Promise<Response | null> {
  const mine = path === "/api/board" || path.startsWith("/api/board/");
  if (!mine && path !== "/api/boards" && !path.startsWith("/api/boards/") && !path.startsWith("/api/invites/")) return null;
  const user = await currentUser(req, env);
  if (!user) return json({ error: "signed out" }, 401);

  if (req.method === "GET") {
    if (path === "/api/board/members") return listMembers(env, user);
    if (path === "/api/board/audit") return auditPage(req, env, user);
    if (path === "/api/board/audit.csv") return auditExport(env, user, "csv");
    if (path === "/api/board/audit.json") return auditExport(env, user, "json");
    if (path === "/api/boards") return boards(env, user);
    if (path === "/api/board/access") {
      const board = new URL(req.url).searchParams.get("board") ?? user.id;
      // Someone else's board: counted first, so a refusal costs nothing more (spendBoardCall).
      const slow = board === user.id ? null : spendBoardCall(user.id);
      if (slow) return slow;
      const a = await access(env, user, board);
      return a.effective === "none" ? fail(404, "not_found", "No such board.") : json({ access: a });
    }
    return null;
  }
  if (req.method !== "POST") return null;
  const raw = await req.json<unknown>().catch(() => null);
  const body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  switch (path) {
    case "/api/board/invites": return invite(req, env, user, body);
    case "/api/board/invites/resend": return resend(req, env, user, body);
    case "/api/board/invites/revoke": return drop(env, user, body, "pending");
    case "/api/board/members/role": return changeRole(env, user, body);
    case "/api/board/members/remove": return drop(env, user, body, "accepted");
    case "/api/invites/lookup": return lookup(req, env, user, body);
    case "/api/invites/accept": return accept(req, env, user, body);
    case "/api/invites/decline": return decline(req, env, user, body);
    case "/api/boards/leave": return leave(env, user, body);
    default: return null;
  }
}
