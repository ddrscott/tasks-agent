import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { getAgentByName } from "agents";
import { handleAttachments } from "./attachments";
import { currentUser, handleAuth, type User } from "./auth";
import { handleBilling } from "./billing";
import { handleMcp, MCP_PATH } from "./mcp";
import { AUTHORIZE_PATH, handleAuthorize, handleGrants } from "./oauth";
import { handleSso } from "./sso";
import { handleTokens, tokenUser } from "./tokens";

export { TodoAgent } from "./agent";

// Everything lives under this path on askscottpierce.com. Static files are built
// into dist/client/tasks/assets (see vite.config.ts), so only the API, the agent
// connection, OAuth, and the MCP endpoint reach this Worker; run_worker_first in
// wrangler.jsonc lists them.
const BASE = "/tasks";

const app: ExportedHandler<Env> = {
  async fetch(req, env) {
    const path = new URL(req.url).pathname;
    if (!path.startsWith(`${BASE}/`)) return new Response("Not found", { status: 404 });
    const sub = path.slice(BASE.length);

    if (sub.startsWith("/api/")) {
      return (await handleAuth(req, env, sub)) ?? (await handleSso(req, env, sub))
        ?? (await handleTokens(req, env, sub)) ?? (await handleGrants(req, env, sub))
        ?? (await handleBilling(req, env, sub)) ?? (await handleAttachments(req, env, sub))
        ?? Response.json({ error: "not found" }, { status: 404 });
    }

    if (path === AUTHORIZE_PATH) return handleAuthorize(req, env);

    // The client connects to /tasks/agent (WebSocket plus a few HTTP calls). The
    // session decides which Durable Object it reaches, so users never name one.
    if (sub === "/agent" || sub.startsWith("/agent/")) {
      const user = await currentUser(req, env);
      if (!user) return new Response("Sign in first", { status: 401 });
      const agent = await getAgentByName(env.TodoAgent, user.id);
      return agent.fetch(req);
    }

    return env.ASSETS.fetch(req);
  },
};

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
