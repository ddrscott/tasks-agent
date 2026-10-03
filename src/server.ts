import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { getAgentByName } from "agents";
import { handleAttachments } from "./attachments";
import { currentUser, handleAuth, type User } from "./auth";
import { handleBilling } from "./billing";
import { handleMcp, MCP_PATH } from "./mcp";
import { AUTHORIZE_PATH, handleAuthorize, handleGrants } from "./oauth";
import { EVENTS_PROTOCOL } from "./events";
import { handleSso } from "./sso";
import { handleTokens, tokenUser } from "./tokens";

export { TodoAgent } from "./agent";
export { TaskEvents } from "./events";

// Everything lives under this path on askscottpierce.com. Static files are built
// into dist/client/tasks/assets (see vite.config.ts), so only the API, the agent
// connection, OAuth, and the MCP endpoint reach this Worker; run_worker_first in
// wrangler.jsonc lists them.
const BASE = "/tasks";

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

const app: ExportedHandler<Env> = {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    if (!path.startsWith(`${BASE}/`)) return new Response("Not found", { status: 404 });
    const sub = path.slice(BASE.length);

    if (sub.startsWith("/api/")) {
      // GETs stay open: sign-in redirects back from Google and Microsoft arrive cross-site, and
      // a cross-origin page can't read what a GET returns anyway.
      const writes = req.method !== "GET" && req.method !== "HEAD";
      if (writes && !NO_ORIGIN_CHECK.has(sub) && fromElsewhere(req)) return forbidden();
      return (await handleAuth(req, env, sub)) ?? (await handleSso(req, env, sub))
        ?? (await handleTokens(req, env, sub)) ?? (await handleGrants(req, env, sub))
        ?? (await handleBilling(req, env, sub)) ?? (await handleAttachments(req, env, sub))
        ?? Response.json({ error: "not found" }, { status: 404 });
    }

    // Agents send people to the consent page from anywhere (GET); the Allow button posts from it.
    if (path === AUTHORIZE_PATH) {
      if (req.method === "POST" && fromElsewhere(req)) return forbidden();
      return handleAuthorize(req, env);
    }

    // The client connects to /tasks/agent (WebSocket plus a few HTTP calls). The
    // session decides which Durable Object it reaches, so users never name one.
    if (sub === "/agent" || sub.startsWith("/agent/")) {
      if (fromElsewhere(req)) return forbidden();
      const user = await currentUser(req, env);
      if (!user) return new Response("Sign in first", { status: 401 });
      const agent = await getAgentByName(env.TodoAgent, user.id);
      return agent.fetch(req);
    }

    // The live feed of your #agent card changes (events.ts), for an agent session on your machine.
    if (sub === "/events") return handleEvents(req, env);

    return env.ASSETS.fetch(req);
  },
};

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
export default new OAuthProvider<Env>({
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
