import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { getAgentByName } from "agents";
import { handleAttachments } from "./attachments";
import { currentUser, handleAuth, type User } from "./auth";
import { handleBilling, handlePlans } from "./billing";
import { handleMcp, MCP_PATH } from "./mcp";
import { access, handleMembers } from "./members";
import { H_EMAIL, H_MEMBER, H_USER, INTERNAL_HEADERS } from "./member-rules";
import { pageAt, pageHead, type Page, type PageHead } from "./routes";
import { AUTHORIZE_PATH, handleAuthorize, handleGrants } from "./oauth";
import { EVENTS_PROTOCOL } from "./events";
import { reportFrom } from "./presence";
import { buildSetup } from "./setup";
import { handleSso } from "./sso";
import { handleTokens, tokenUser } from "./tokens";
// The installer and the two scripts it puts on a machine, as text (// SESSIONS).
import eventsScript from "../scripts/tasks-events.mjs?raw";
import presenceScript from "../scripts/tasks-presence.mjs?raw";
import setupScript from "../scripts/tasks-setup.mjs?raw";

export { TodoAgent } from "./agent";
export { TaskEvents } from "./events";
export { Presence } from "./presence";

// Everything lives under this path on askscottpierce.com. The Worker answers all of it except
// the hashed build output in /tasks/assets and the Needle model files, which the asset layer
// serves on its own (run_worker_first in wrangler.jsonc). That's what lets an address that
// isn't a page get a real 404.
const BASE = "/tasks";

/**
 * The app's HTML. Every page is the same document, and the client draws the one the address
 * names. `status` is 404 for an address that names nothing, so crawlers and link checkers hear
 * the truth while a person still gets the not-found page with its links.
 *
 * The head is written per page on the way out (PAGE_META in src/routes.ts): link-preview
 * fetchers don't run JavaScript, so the title a shared link shows has to be in this HTML.
 */
async function shell(req: Request, env: Env, page: Page | null): Promise<Response> {
  // A bare request: a 404 must never come back as "304 Not Modified" from a conditional header.
  const html = await env.ASSETS.fetch(new Request(new URL("/", req.url), { method: req.method === "HEAD" ? "HEAD" : "GET" }));
  if (!html.ok) return html;
  const headers = new Headers(html.headers);
  // The same file is a different document at each address now, so its ETag and length no longer describe it.
  headers.delete("ETag");
  headers.delete("Content-Length");
  if (page === null) headers.set("Cache-Control", "no-store");
  const status = page === null ? 404 : 200;
  if (!html.body) return new Response(null, { status, headers });
  return new Response(withHead(html, pageHead(page)).body, { status, headers });
}

/**
 * Write one page's head into index.html: <title>, the description, canonical, and the og: and
 * twitter: copies of each. index.html holds the front page's own tags, so `/tasks/` only gets
 * its title set (from the same constant the client uses). Every other page also loses the
 * JSON-LD block, which describes the product on the front page and nowhere else. An address
 * that names nothing gets `noindex` and no canonical or og:url: there's no page to point at.
 */
function withHead(html: Response, head: PageHead): Response {
  const content = (value: string | null) => ({
    element(el: Element) {
      if (value === null) el.remove(); else el.setAttribute("content", value);
    },
  });
  let rw = new HTMLRewriter()
    .on("title", { element(el) { el.setInnerContent(head.title); } })
    .on('meta[property="og:title"]', content(head.title))
    .on('meta[name="twitter:title"]', content(head.title));
  if (head.landing) return rw.transform(html);
  rw = rw
    .on('link[rel="canonical"]', { element(el) { if (head.url) el.setAttribute("href", head.url); else el.remove(); } })
    .on('meta[property="og:url"]', content(head.url))
    .on('script[type="application/ld+json"]', { element(el) { el.remove(); } });
  if (head.description !== null) {
    rw = rw
      .on('meta[name="description"]', content(head.description))
      .on('meta[property="og:description"]', content(head.description))
      .on('meta[name="twitter:description"]', content(head.description));
  }
  if (!head.index) rw = rw.on('meta[name="robots"]', content("noindex"));
  return rw.transform(html);
}

/**
 * A browser request sent from another origin. The session cookie is SameSite=Lax, which
 * still lets a sibling subdomain (same site) open the agent WebSocket or POST with it, so
 * everything that acts on the cookie checks this too. Browsers send Origin on POSTs and
 * WebSocket upgrades, and Sec-Fetch-Site on everything; tools like curl send neither and
 * carry no ambient cookie, so they pass. It can't stop scripts on askscottpierce.com itself
 * (README → Accepted risk: a shared origin).
 */
function fromElsewhere(req: Request): boolean {
  const origin = req.headers.get("Origin");
  if (origin !== null && origin !== new URL(req.url).origin) return true;
  const site = req.headers.get("Sec-Fetch-Site");
  return site !== null && site !== "same-origin" && site !== "none";
}

const forbidden = () => Response.json({ error: "Requests have to come from Tasks itself." }, { status: 403 });

/** Stripe calls this from its servers, and it's authenticated by its signature, not a cookie. */
const NO_ORIGIN_CHECK = new Set(["/api/stripe/webhook"]);

/**
 * The only addresses that answer a WebSocket upgrade: the board (`/agent`, your own or one
 * shared with you), the Sessions list (`/presence`), and the agent event feed (`/events`).
 * Exact paths, nothing under them.
 */
const SOCKET_PATHS: ReadonlySet<string> = new Set([`${BASE}/agent`, `${BASE}/presence`, `${BASE}/events`]);

/**
 * An upgrade to anywhere else is refused here, before the OAuth provider, the asset layer, or
 * the page shell see it. None of those expect one: handed an upgrade for a file or a page, the
 * local emulator's asset layer died on an assertion, with no sign-in needed to send it. That
 * covers the Agents SDK's own address shape (`/agents/<class>/<name>`) too, which this app
 * never routes.
 */
function strayUpgrade(req: Request): Response | null {
  if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return null;
  let path: string;
  try { path = new URL(req.url).pathname; } catch { return new Response("Bad request", { status: 400 }); }
  if (SOCKET_PATHS.has(path)) return null;
  return new Response("There's no WebSocket at this address.", { status: 404, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" } });
}

const app: ExportedHandler<Env> = {
  async fetch(req, env) {
    const stray = strayUpgrade(req);
    if (stray) return stray;
    const path = new URL(req.url).pathname;
    if (path !== BASE && !path.startsWith(`${BASE}/`)) return new Response("Not found", { status: 404 });
    const sub = path.slice(BASE.length);

    if (sub.startsWith("/api/")) {
      // GETs stay open: sign-in redirects back from Google and Microsoft arrive cross-site, and
      // a cross-origin page can't read what a GET returns anyway.
      const writes = req.method !== "GET" && req.method !== "HEAD";
      if (writes && !NO_ORIGIN_CHECK.has(sub) && fromElsewhere(req)) return forbidden();
      if (sub === "/api/presence" && req.method === "POST") return handlePresenceReport(req, env);
      return (await handleAuth(req, env, sub)) ?? (await handleSso(req, env, sub))
        ?? (await handleTokens(req, env, sub)) ?? (await handleGrants(req, env, sub))
        ?? (await handlePlans(req, env, sub)) ?? (await handleBilling(req, env, sub)) ?? (await handleAttachments(req, env, sub))
        ?? (await handleMembers(req, env, sub))
        ?? Response.json({ error: "not found" }, { status: 404 });
    }

    // Agents send people to the consent page from anywhere (GET); the Allow button posts from it.
    if (path === AUTHORIZE_PATH) {
      if (req.method === "POST" && fromElsewhere(req)) return forbidden();
      return handleAuthorize(req, env);
    }

    // The client connects to /tasks/agent (WebSocket plus a few HTTP calls). With no `board`
    // in the query the session decides which Durable Object it reaches: your own. `?board=<id>`
    // asks for a board someone shared with you, and the membership check decides (// TEAM_BOARDS).
    if (sub === "/agent" || sub.startsWith("/agent/")) {
      if (fromElsewhere(req)) return forbidden();
      const user = await currentUser(req, env);
      if (!user) return new Response("Sign in first", { status: 401 });
      const board = new URL(req.url).searchParams.get("board");
      if (board !== null && board !== user.id) return memberConnect(req, env, user, sub, board);
      // Who's calling is said in headers only the Worker may set, so drop any the browser sent.
      const headers = new Headers(req.headers);
      for (const h of INTERNAL_HEADERS) headers.delete(h);
      headers.set(H_USER, user.id);
      headers.set(H_EMAIL, encodeURIComponent(user.email)); // header values are bytes; an email needn't be
      const agent = await getAgentByName(env.TodoAgent, user.id);
      return agent.fetch(new Request(req, { headers }));
    }

    // The live feed of your #agent card changes (events.ts), for an agent session on your machine.
    if (sub === "/events") return handleEvents(req, env);

    // The browser's live list of Claude Code sessions and card claims (presence.ts).
    if (sub === "/presence") {
      if (fromElsewhere(req)) return forbidden();
      const user = await currentUser(req, env);
      if (!user) return new Response("Sign in first", { status: 401 });
      const headers = new Headers(req.headers);
      headers.delete("Cookie");
      headers.set("x-user", user.id);
      return env.Presence.get(env.Presence.idFromName(user.id)).fetch(new Request(req.url, { headers }));
    }

    // The one-command Sessions setup: `curl … /tasks/setup.mjs | TASKS_TOKEN=… node --input-type=module -`.
    // Public and the same for everyone. The token travels in the caller's environment, never in this URL.
    if (sub === "/setup.mjs") {
      const body = buildSetup(setupScript, { "tasks-presence.mjs": presenceScript, "tasks-events.mjs": eventsScript }, new URL(req.url).origin);
      return new Response(body, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    }

    // A page (src/routes.ts lists them) gets the app. Anything else is a file in public/tasks,
    // like og.png, or it's nothing, and nothing is a 404 that still draws the not-found page.
    const page = pageAt(path, BASE);
    if (page) return shell(req, env, page);
    const file = await env.ASSETS.fetch(req);
    return file.status === 404 ? shell(req, env, null) : file;
  },
};

/**
 * Someone asking for a board that isn't theirs. One check (access in members.ts), and one
 * answer for every way it can fail: a stranger, a pending invite, a removed member, an
 * encrypted board, a made-up id. Nothing in it says whether the board exists.
 *
 * A member gets a WebSocket and nothing else: no HTTP calls into the owner's object, no path
 * under /agent, and none of the browser's headers. The request the board sees is built here
 * from scratch, with the member the Worker just checked.
 */
async function memberConnect(req: Request, env: Env, user: User, sub: string, board: string): Promise<Response> {
  const refuse = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (sub !== "/agent" || req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return refuse();
  const a = await access(env, user, board);
  if (a.effective === "none" || a.role === "owner") return refuse();
  const agent = await getAgentByName(env.TodoAgent, board);
  const res = await agent.fetch(new Request("https://tasks.internal/agent", {
    headers: { Upgrade: "websocket", [H_MEMBER]: encodeURIComponent(JSON.stringify({ id: user.id, email: user.email })) },
  }));
  return res.status === 101 && res.webSocket ? relay(res.webSocket) : res;
}

/** The biggest frame a member's browser may send (MEMBER_FRAME_MAX in agent.ts checks it again). */
const MEMBER_FRAME_MAX = 32 * 1024;

/**
 * Stand between a member's browser and the board's end of their socket, passing frames both
 * ways, so that when the board closes the socket (removed, left, lost access, flooding) the
 * browser's connection ends then and there. Handing the board's socket straight through, a
 * socket that had never sent a frame got the board's last frame at once but stayed open until
 * the board's object next went idle, about ten seconds later. Here the Worker hears the close
 * and closes the browser's side itself, with the same code and reason.
 *
 * It adds no way in: both ends exist only after memberConnect's access check and the board's
 * own. It only ever narrows what gets through: text frames up to MEMBER_FRAME_MAX from the
 * browser, and whatever the board sends back.
 */
function relay(board: WebSocket): Response {
  const [browser, mine] = Object.values(new WebSocketPair());
  board.accept();
  mine.accept();
  const shut = (ws: WebSocket, code: number, reason: string) => {
    // 1005 and 1006 mean "no code came" and can't be sent.
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch { /* already closed */ }
  };
  const both = (code: number, reason: string) => { shut(mine, code, reason); shut(board, code, reason); };
  board.addEventListener("message", (e) => { try { mine.send(e.data); } catch { /* the browser went away */ } });
  mine.addEventListener("message", (e) => {
    if (typeof e.data !== "string" || e.data.length > MEMBER_FRAME_MAX) return both(1009, "frame too big");
    try { board.send(e.data); } catch { /* the board closed it */ }
  });
  board.addEventListener("close", (e) => both(e.code, e.reason));
  mine.addEventListener("close", (e) => both(e.code, e.reason));
  board.addEventListener("error", () => both(1011, "board socket error"));
  mine.addEventListener("error", () => both(1011, "socket error"));
  return new Response(null, { status: 101, webSocket: browser });
}

/** The most a hook may send. Real payloads are a few hundred bytes; a Write's tool_input can be big, and it's thrown away. */
const PRESENCE_MAX_BYTES = 256 * 1024;

/**
 * A Claude Code session reporting in (presence.ts). It takes a personal access token, never a
 * cookie, and the body is the hook's own JSON. The machine name comes from the
 * X-Tasks-Machine header (or ?machine=), since Claude Code doesn't send one.
 *
 * Every answer is a 200 with an empty object unless the token is wrong. A hook is never a
 * reason to slow a session down or show it an error, so bad input is dropped quietly.
 */
async function handlePresenceReport(req: Request, env: Env): Promise<Response> {
  const user = await tokenUser(req, env);
  if (!user) return Response.json({ error: "Send a personal access token (Connect an agent → Tokens)." }, { status: 401 });
  const noop = (note: string) => new Response("{}", { headers: { "Content-Type": "application/json", "X-Tasks-Presence": note } });
  if (Number(req.headers.get("Content-Length") ?? 0) > PRESENCE_MAX_BYTES) return noop("too-big");
  const raw = await req.text().catch(() => "");
  if (raw.length > PRESENCE_MAX_BYTES) return noop("too-big");
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return noop("not-json"); }
  const q = new URL(req.url).searchParams;
  const b = (body ?? {}) as Record<string, unknown>;
  const pick = (header: string, key: string) => req.headers.get(header) ?? q.get(key) ?? (typeof b[key] === "string" ? (b[key] as string) : null);
  const report = reportFrom(body, { machine: pick("X-Tasks-Machine", "machine"), agent: pick("X-Tasks-Agent", "agent"), link: pick("X-Tasks-Link", "link") });
  if (!report) return noop("no-session");
  const presence = env.Presence.get(env.Presence.idFromName(user.id));
  return noop(await presence.report(user.id, report));
}

/**
 * Open the event feed. It takes a personal access token, never a cookie: in the
 * Authorization header, or for WebSocket clients that can't set headers (Claude Code's
 * Monitor, browsers) as a second subprotocol after "tasks-events". Never in the URL,
 * which ends up in logs.
 */
async function handleEvents(req: Request, env: Env): Promise<Response> {
  if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
  if (fromElsewhere(req)) return forbidden();
  const offered = (req.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  let auth = req;
  if (!req.headers.has("Authorization") && offered[0] === EVENTS_PROTOCOL && offered[1]) {
    auth = new Request(req.url, { headers: { Authorization: `Bearer ${offered[1]}` } });
  }
  const user = await tokenUser(auth, env);
  if (!user) return new Response("Send a personal access token (Connect an agent → Tokens).", { status: 401 });
  const headers = new Headers(req.headers);
  headers.delete("Authorization");
  headers.set("x-user", user.id);
  if (offered.length) headers.set("Sec-WebSocket-Protocol", EVENTS_PROTOCOL); // the token stops at the Worker
  else headers.delete("Sec-WebSocket-Protocol");
  return env.TaskEvents.get(env.TaskEvents.idFromName(user.id)).fetch(new Request(req.url, { headers }));
}

// The OAuth provider sits in front of the app. It answers OAuth discovery, client
// registration, and the token endpoint itself, checks the bearer token on /tasks/mcp,
// and passes everything else to the app above. Grants and tokens live in OAUTH_KV.
//
// Discovery lives at the domain root, which is why wrangler.jsonc routes two
// /.well-known paths here:
//   /.well-known/oauth-protected-resource/tasks/mcp  → "this resource uses askscottpierce.com"
//   /.well-known/oauth-authorization-server          → the endpoints below
const provider = new OAuthProvider<Env>({
  apiRoute: MCP_PATH,
  apiHandler: {
    fetch: (req, env, ctx) => handleMcp(req, env, ctx, (ctx as ExecutionContext & { props: User }).props),
  },
  defaultHandler: app,
  authorizeEndpoint: AUTHORIZE_PATH,
  tokenEndpoint: `${BASE}/oauth/token`,
  clientRegistrationEndpoint: `${BASE}/oauth/register`,
  // Newer MCP clients identify themselves with a URL to their metadata instead of registering.
  clientIdMetadataDocumentEnabled: true,
  accessTokenTTL: 60 * 60,
  refreshTokenTTL: 90 * 24 * 60 * 60,
  // Personal access tokens from the Connect page still work, for clients that take a pasted token.
  resolveExternalToken: async ({ request, env }) => {
    const user = await tokenUser(request, env);
    return user ? { props: user } : null;
  },
});

export default {
  fetch(req, env, ctx) {
    // First thing, for every request: see strayUpgrade.
    return strayUpgrade(req) ?? provider.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;
