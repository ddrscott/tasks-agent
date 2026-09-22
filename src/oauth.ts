// OAuth for outside agents. The OAuth provider (server.ts) handles discovery, client
// registration, and tokens; this file is the part a person sees: the consent screen
// at /tasks/oauth/authorize, plus the API behind "Connected apps" on the Connect page.
//
// Clients register themselves (Dynamic Client Registration), so a client's name
// is whatever it claims. The consent screen shows where it will send you back to,
// and every connection needs an explicit Allow.

import { AuthorizationError, type AuthRequest, type ClientInfo } from "@cloudflare/workers-oauth-provider";
import { csrfToken, currentUser } from "./auth";

export const AUTHORIZE_PATH = "/tasks/oauth/authorize";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const clientLabel = (c: ClientInfo | null) => (c?.clientName?.trim() || "An app").slice(0, 80);

function page(title: string, body: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Tasks</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=JetBrains+Mono:wght@400;600&display=swap">
<style>
:root { --bg:#fffef9; --surface:#f7f6f3; --ink:#2c2c2c; --muted:#6b6b6b; --line:#dddad2; --accent:#e85d00; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg:#1a1a1a; --surface:#242424; --ink:#e0e0e0; --muted:#8a8a8a; --line:#363636; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px 16px; background:var(--bg); color:var(--ink); font:15px/1.5 Inter, system-ui, sans-serif; }
main { width:min(440px,100%); background:var(--surface); border:1px solid var(--line); padding:28px; display:flex; flex-direction:column; gap:16px; }
.wordmark { font-weight:700; font-size:22px; margin:0; color:var(--ink); } .wordmark span { color:var(--accent); }
.h { font:600 11px/1 "JetBrains Mono", monospace; letter-spacing:.1em; color:var(--muted); margin:0; }
.h::before { content:"// "; color:var(--accent); }
h1 { font-size:22px; line-height:1.25; margin:0; }
p { margin:0; color:var(--muted); }
ul { margin:0; padding-left:18px; color:var(--muted); } li::marker { color:var(--accent); }
code, .mono { font:13px "JetBrains Mono", monospace; color:var(--ink); overflow-wrap:anywhere; }
.facts { border-top:1px solid var(--line); border-bottom:1px solid var(--line); padding:12px 0; display:grid; grid-template-columns:auto 1fr; gap:6px 12px; font-size:13px; }
.facts dt { color:var(--muted); font:12px "JetBrains Mono", monospace; } .facts dd { margin:0; }
.row { display:flex; gap:8px; } form { margin:0; }
button { font:600 14px Inter, sans-serif; height:42px; padding:0 18px; border:1px solid var(--line); background:var(--surface); color:var(--ink); cursor:pointer; flex:1; }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
button:hover { border-color:var(--accent); }
a { color:var(--accent); }
</style></head><body><main><p class="wordmark">tasks<span>.</span></p>${body}</main></body></html>`, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // The consent screen must never load inside someone else's frame (clickjacking).
      "Content-Security-Policy": "frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    },
  });
}

const errorPage = (message: string, status = 400) =>
  page("Can't connect", `<p class="h">CONNECT_FAILED</p><h1>That connection request didn't work.</h1><p>${esc(message)}</p><p><a href="/tasks/">Go to your board</a></p>`, status);

/** Hand an OAuth error back to the client when the request got far enough to know where to send it. */
function errorResponse(e: unknown): Response {
  if (e instanceof AuthorizationError && e.redirectUri) {
    const url = new URL(e.redirectUri);
    url.searchParams.set("error", e.code);
    if (e.description) url.searchParams.set("error_description", e.description);
    if (e.state) url.searchParams.set("state", e.state);
    if (e.issuer) url.searchParams.set("iss", e.issuer);
    return Response.redirect(url.toString(), 302);
  }
  return errorPage((e as Error).message || "The request was malformed.");
}

async function parse(req: Request, env: Env): Promise<{ auth: AuthRequest; client: ClientInfo | null } | Response> {
  try {
    const auth = await env.OAUTH_PROVIDER.parseAuthRequest(req);
    return { auth, client: await env.OAUTH_PROVIDER.lookupClient(auth.clientId) };
  } catch (e) {
    return errorResponse(e);
  }
}

async function showConsent(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const user = await currentUser(req, env);
  if (!user) {
    // Sign in first (email code, Google, or Microsoft), then come straight back here.
    const login = new URL("/tasks/", url);
    login.searchParams.set("next", url.pathname + url.search);
    return Response.redirect(login.toString(), 302);
  }
  const parsed = await parse(req, env);
  if (parsed instanceof Response) return parsed;
  const { auth, client } = parsed;
  const name = clientLabel(client);
  const dest = new URL(auth.redirectUri);
  const csrf = (await csrfToken(req))!;

  return page(`Connect ${name}`, `
<p class="h">CONNECT_AN_AGENT</p>
<h1><span class="mono" style="font-size:20px">${esc(name)}</span> wants access to your Tasks.</h1>
<p>If you allow it, it can:</p>
<ul><li>see every lane and card</li><li>add, edit, move, and delete cards and lanes</li></ul>
<dl class="facts">
  <dt>signed in</dt><dd>${esc(user.email)}</dd>
  <dt>returns to</dt><dd><code>${esc(dest.origin)}</code></dd>
</dl>
<p>Only allow this if you just started connecting from ${esc(name)}. Anything it changes can be undone on the board, and you can disconnect it from the Connect page.</p>
<form method="post" action="${AUTHORIZE_PATH}">
  <input type="hidden" name="q" value="${esc(url.search)}">
  <input type="hidden" name="csrf" value="${esc(csrf)}">
  <div class="row">
    <button name="decision" value="deny">Cancel</button>
    <button class="primary" name="decision" value="allow" autofocus>Allow</button>
  </div>
</form>
<p style="font-size:13px">Not ${esc(user.email)}? <a href="/tasks/">Switch accounts on the board</a>, then connect again.</p>`);
}

async function decide(req: Request, env: Env): Promise<Response> {
  const user = await currentUser(req, env);
  if (!user) return errorPage("Your session ended. Start connecting again.", 401);
  const form = await req.formData();
  const csrf = await csrfToken(req);
  if (!csrf || form.get("csrf") !== csrf) return errorPage("This form expired. Start connecting again.", 403);
  const q = String(form.get("q") ?? "");
  if (!q.startsWith("?")) return errorPage("The request was malformed.");

  // Re-parse from the original query so the client, redirect, and PKCE challenge
  // are validated again rather than trusted from the form.
  const parsed = await parse(new Request(new URL(AUTHORIZE_PATH + q, req.url)), env);
  if (parsed instanceof Response) return parsed;
  const { auth, client } = parsed;

  if (form.get("decision") !== "allow") {
    const back = new URL(auth.redirectUri);
    back.searchParams.set("error", "access_denied");
    if (auth.state) back.searchParams.set("state", auth.state);
    return Response.redirect(back.toString(), 302);
  }

  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: auth,
    userId: user.id,
    scope: auth.scope,
    metadata: { clientName: clientLabel(client), email: user.email },
    props: { id: user.id, email: user.email },
  });
  return Response.redirect(redirectTo, 302);
}

export async function handleAuthorize(req: Request, env: Env): Promise<Response> {
  if (req.method === "GET") return showConsent(req, env);
  if (req.method === "POST") return decide(req, env);
  return new Response("Method not allowed", { status: 405 });
}

export type GrantInfo = { id: string; name: string; createdAt: number };

/** /api/grants lists and revokes the apps connected with OAuth. Session only. */
export async function handleGrants(req: Request, env: Env, path: string): Promise<Response | null> {
  if (path !== "/api/grants" && !path.startsWith("/api/grants/")) return null;
  const user = await currentUser(req, env);
  if (!user) return Response.json({ error: "signed out" }, { status: 401 });
  if (path === "/api/grants" && req.method === "GET") {
    const { items } = await env.OAUTH_PROVIDER.listUserGrants(user.id);
    const grants: GrantInfo[] = items
      .map((g) => ({ id: g.id, name: String(g.metadata?.clientName ?? "An app"), createdAt: g.createdAt * (g.createdAt < 1e12 ? 1000 : 1) }))
      .sort((a, b) => b.createdAt - a.createdAt);
    return Response.json({ grants });
  }
  const id = decodeURIComponent(path.slice("/api/grants/".length));
  if (id && req.method === "DELETE") {
    await env.OAUTH_PROVIDER.revokeGrant(id, user.id);
    return Response.json({ ok: true });
  }
  return null;
}
