// Personal access tokens, so outside agents can reach a user's board over MCP
// without a browser session. The user creates one on the Connect page and pastes
// it into Glean, Claude Code, Cursor, and so on. Only the hash is stored, and the
// plain token is shown once.

import { currentUser, randomToken, sha256, userIdFor, type User } from "./auth";

const MAX_TOKENS = 10;
const PREFIX = "tasks_";
// Writing last_used_at on every MCP call would be a D1 write per tool call. A minute is precise enough.
const TOUCH_EVERY_MS = 60 * 1000;

export type TokenInfo = { id: string; name: string; createdAt: number; lastUsedAt: number | null };

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** The user a `Authorization: Bearer tasks_…` header belongs to, or null. */
export async function tokenUser(req: Request, env: Env): Promise<User | null> {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("Authorization") ?? "");
  if (!m || !m[1].startsWith(PREFIX)) return null;
  const row = await env.DB.prepare("SELECT id, email, last_used_at FROM api_tokens WHERE token_hash = ?")
    .bind(await sha256(m[1]))
    .first<{ id: string; email: string; last_used_at: number | null }>();
  if (!row) return null;
  if (!row.last_used_at || Date.now() - row.last_used_at > TOUCH_EVERY_MS) {
    await env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(Date.now(), row.id).run();
  }
  return { email: row.email, id: await userIdFor(row.email) };
}

async function list(env: Env, user: User): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT id, name, created_at, last_used_at FROM api_tokens WHERE email = ? ORDER BY created_at DESC",
  ).bind(user.email).all<{ id: string; name: string; created_at: number; last_used_at: number | null }>();
  const tokens: TokenInfo[] = results.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
  return json({ tokens });
}

async function create(req: Request, env: Env, user: User): Promise<Response> {
  const body = await req.json<{ name?: unknown }>().catch(() => ({}) as { name?: unknown });
  const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim().slice(0, 60) : "";
  if (!name) return json({ error: "Give the token a name, like the agent it's for." }, 400);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE email = ?").bind(user.email).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_TOKENS) return json({ error: `You can have ${MAX_TOKENS} tokens. Revoke one first.` }, 400);

  const token = PREFIX + randomToken();
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO api_tokens (id, token_hash, email, name, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, await sha256(token), user.email, name, now).run();
  const info: TokenInfo = { id, name, createdAt: now, lastUsedAt: null };
  return json({ token, info });
}

async function revoke(env: Env, user: User, id: string): Promise<Response> {
  await env.DB.prepare("DELETE FROM api_tokens WHERE id = ? AND email = ?").bind(id, user.email).run();
  return json({ ok: true });
}

/** /api/tokens routes. They need a browser session: a token can't mint more tokens. */
export async function handleTokens(req: Request, env: Env, path: string): Promise<Response | null> {
  if (path !== "/api/tokens" && !path.startsWith("/api/tokens/")) return null;
  const user = await currentUser(req, env);
  if (!user) return json({ error: "signed out" }, 401);
  if (path === "/api/tokens" && req.method === "GET") return list(env, user);
  if (path === "/api/tokens" && req.method === "POST") return create(req, env, user);
  const id = path.slice("/api/tokens/".length);
  if (id && req.method === "DELETE") return revoke(env, user, decodeURIComponent(id));
  return null;
}
