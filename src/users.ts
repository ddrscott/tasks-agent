// Who's an admin, and who was given Pro without paying. Stripe owns subscriptions
// (billing.ts); this is the part Stripe doesn't know.
//
// - `users` has a row for everyone who has signed in (written at each sign-in) and for anyone
//   an admin added by email before they did. `role` is "user" or "admin"; `pro_grant` is Pro
//   given by an admin. A person is on Pro when they have a live subscription or a grant.
// - ADMIN_EMAILS (wrangler.jsonc) lists the root admins. They're admins whatever the table
//   says and can't be demoted from the app, so there's always a way back in.
// - /api/admin/* takes a browser session, never an access token: an agent holding an admin's
//   token can work that admin's board, not hand out roles. Every call checks the role here, on
//   the server. Admins can list accounts and set the two flags, and that's all: no reading
//   boards, no deleting accounts, no signing in as someone.

import { currentUser, normalizeEmail, userIdFor, type User } from "./auth";
import { subscriptionIsPro } from "./billing";
import { planChanged } from "./members";

export type Role = "user" | "admin";

/** One account, as the admin page lists it. */
export type AdminUser = {
  email: string;
  role: Role;
  /** Named in ADMIN_EMAILS: always an admin, and not changeable here. */
  root: boolean;
  /** Pro given by an admin. */
  proGrant: boolean;
  /** The Stripe subscription's status, when there is one. */
  stripe: string | null;
  /** What they get: a live subscription or a grant makes it pro. */
  plan: "free" | "pro";
  createdAt: number;
  /** Null for someone added by email who hasn't signed in yet. */
  lastSeenAt: number | null;
  changedBy: string | null;
  changedAt: number | null;
};

const json = (body: unknown, status = 200) => Response.json(body, { status });

export function rootAdmins(env: Env): string[] {
  return (env.ADMIN_EMAILS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Whether this email may use the admin page: a root admin, or one made an admin there. */
export async function isAdmin(env: Env, email: string): Promise<boolean> {
  if (rootAdmins(env).includes(email)) return true;
  try {
    const row = await env.DB.prepare("SELECT role FROM users WHERE email = ?").bind(email).first<{ role: string }>();
    return row?.role === "admin";
  } catch (e) {
    console.error("users", (e as Error).message);
    return false;
  }
}

/**
 * Note a sign-in: make the account's row, or stamp when it was last seen. Never throws: a
 * sign-in mustn't fail because this bookkeeping did (say, before the migration has run).
 */
export async function noteSignIn(env: Env, email: string): Promise<void> {
  try {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO users (email, user_id, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT(email) DO UPDATE SET user_id = excluded.user_id, last_seen_at = excluded.last_seen_at`,
    ).bind(email, await userIdFor(email), now).run();
  } catch (e) {
    console.error("users", (e as Error).message);
  }
}

/** Whether an admin gave this user Pro. False when the table can't be read, so billing falls back to Stripe alone. */
export async function proGranted(env: Env, userId: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare("SELECT pro_grant FROM users WHERE user_id = ?").bind(userId).first<{ pro_grant: number }>();
    return !!row?.pro_grant;
  } catch (e) {
    console.error("users", (e as Error).message);
    return false;
  }
}

type Row = {
  email: string; role: string; pro_grant: number; created_at: number; last_seen_at: number | null;
  changed_by: string | null; changed_at: number | null; status: string | null; current_period_end: number | null;
};

const SELECT = `SELECT u.email, u.role, u.pro_grant, u.created_at, u.last_seen_at, u.changed_by, u.changed_at,
  s.status, s.current_period_end FROM users u LEFT JOIN subscriptions s ON s.user_id = u.user_id`;

function shape(env: Env, r: Row): AdminUser {
  const root = rootAdmins(env).includes(r.email);
  const paying = !!r.status && subscriptionIsPro({ status: r.status, current_period_end: r.current_period_end });
  return {
    email: r.email, role: root || r.role === "admin" ? "admin" : "user", root,
    proGrant: !!r.pro_grant, stripe: r.status, plan: paying || r.pro_grant ? "pro" : "free",
    createdAt: r.created_at, lastSeenAt: r.last_seen_at, changedBy: r.changed_by, changedAt: r.changed_at,
  };
}

/** The most accounts the page lists. Past this it needs paging, which it doesn't have yet. */
const LIST_MAX = 500;

async function list(env: Env): Promise<Response> {
  // A root admin who hasn't signed in since the table was made still belongs on the list.
  const now = Date.now();
  for (const email of rootAdmins(env)) {
    await env.DB.prepare("INSERT OR IGNORE INTO users (email, user_id, created_at) VALUES (?, ?, ?)").bind(email, await userIdFor(email), now).run();
  }
  const { results } = await env.DB.prepare(`${SELECT} ORDER BY COALESCE(u.last_seen_at, u.created_at) DESC LIMIT ?`).bind(LIST_MAX + 1).all<Row>();
  return json({ users: results.slice(0, LIST_MAX).map((r) => shape(env, r)), more: results.length > LIST_MAX });
}

/**
 * Set someone's admin role, their Pro grant, or both. The account doesn't have to exist yet:
 * naming an email that has never signed in adds it, and the flags are waiting when it does.
 */
async function update(req: Request, env: Env, admin: User): Promise<Response> {
  const body = await req.json<{ email?: unknown; admin?: unknown; pro?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const email = normalizeEmail(body.email);
  if (!email) return json({ error: "That doesn't look like an email address." }, 400);
  const setAdmin = typeof body.admin === "boolean" ? body.admin : undefined;
  const setPro = typeof body.pro === "boolean" ? body.pro : undefined;
  if (setAdmin === false && rootAdmins(env).includes(email)) {
    return json({ error: `${email} is a root admin (ADMIN_EMAILS in wrangler.jsonc) and can't be changed here.` }, 400);
  }
  if (setAdmin === false && email === admin.email) {
    return json({ error: "You can't take your own admin role away. Ask another admin to." }, 400);
  }
  const now = Date.now();
  const changed = setAdmin !== undefined || setPro !== undefined;
  await env.DB.prepare(
    `INSERT INTO users (email, user_id, role, pro_grant, created_at, changed_by, changed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(email) DO UPDATE SET user_id = excluded.user_id,
       role = CASE WHEN ?8 THEN excluded.role ELSE role END,
       pro_grant = CASE WHEN ?9 THEN excluded.pro_grant ELSE pro_grant END,
       changed_by = CASE WHEN ?10 THEN excluded.changed_by ELSE changed_by END,
       changed_at = CASE WHEN ?10 THEN excluded.changed_at ELSE changed_at END`,
  ).bind(
    email, await userIdFor(email), setAdmin ? "admin" : "user", setPro ? 1 : 0, now,
    changed ? admin.email : null, changed ? now : null,
    setAdmin !== undefined ? 1 : 0, setPro !== undefined ? 1 : 0, changed ? 1 : 0,
  ).run();
  // A shared board follows its owner's plan, and a grant is part of the plan (planSource in
  // billing.ts). So this tells the owner's board the same way the Stripe webhook does
  // (storeSubscription): the audit log gets "sharing suspended" or "sharing restored", and open
  // member sockets drop to view only, or get their roles back, before this answers. It reads
  // the plan fresh, so taking a grant from someone who also pays changes nothing. The board's
  // own 30-second sweep is the backstop if this fails.
  if (setPro !== undefined) {
    await planChanged(env, await userIdFor(email)).catch((e: Error) => console.error("telling the board about a plan change failed", e.message));
  }
  const row = await env.DB.prepare(`${SELECT} WHERE u.email = ?`).bind(email).first<Row>();
  console.log(`admin: ${admin.email} set ${email}${setAdmin !== undefined ? ` admin=${setAdmin}` : ""}${setPro !== undefined ? ` pro=${setPro}` : ""}`);
  return json({ user: shape(env, row!) });
}

/** /api/admin/*. Signed out is 401, signed in without the role is 403. */
export async function handleAdmin(req: Request, env: Env, path: string): Promise<Response | null> {
  if (!path.startsWith("/api/admin/")) return null;
  const user = await currentUser(req, env);
  if (!user) return json({ error: "signed out" }, 401);
  if (!(await isAdmin(env, user.email))) return json({ error: "That's for admins." }, 403);
  try {
    if (path === "/api/admin/users" && req.method === "GET") return await list(env);
    if (path === "/api/admin/users" && req.method === "POST") return await update(req, env, user);
  } catch (e) {
    console.error("admin", (e as Error).message);
    return json({ error: "That didn't work. If this is a new deploy, the users migration may not have run yet." }, 500);
  }
  return null;
}
