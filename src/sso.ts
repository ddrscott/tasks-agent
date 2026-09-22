// "Continue with Google" and "Continue with Microsoft" (Outlook, Hotmail, Microsoft 365).
// Standard OpenID Connect authorization code flow with PKCE. Whatever the provider,
// the result is a verified email address, which becomes the same session the
// emailed code gives, so a person gets the same board however they sign in.
// Each provider is enabled when both of its secrets are set.

import { allowed, createSession, normalizeEmail, safeNext } from "./auth";
import { TURNSTILE_ACTION, turnstileEnabled } from "./turnstile";

type Claims = Record<string, unknown>;

type Provider = {
  label: string;
  authorize: string;
  token: string;
  clientId(env: Env): string | undefined;
  clientSecret(env: Env): string | undefined;
  /** Returns the email if the provider vouches for it, or an error to show. */
  verifiedEmail(claims: Claims): { email: string } | { error: string };
  issuerOk(iss: unknown, claims: Claims): boolean;
};

// Personal Microsoft accounts (outlook.com, hotmail.com, live.com) all sign in through this tenant.
const MSA_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

const PROVIDERS: Record<string, Provider> = {
  google: {
    label: "Google",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    clientId: (env) => env.GOOGLE_CLIENT_ID,
    clientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
    issuerOk: (iss) => iss === "https://accounts.google.com" || iss === "accounts.google.com",
    verifiedEmail: (c) =>
      c.email_verified === true && typeof c.email === "string"
        ? { email: c.email }
        : { error: "Google didn't share a verified email for that account." },
  },
  microsoft: {
    label: "Microsoft",
    // "common" accepts both personal accounts and work or school accounts.
    authorize: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    token: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    clientId: (env) => env.MICROSOFT_CLIENT_ID,
    clientSecret: (env) => env.MICROSOFT_CLIENT_SECRET,
    issuerOk: (iss, c) => typeof c.tid === "string" && iss === `https://login.microsoftonline.com/${c.tid}/v2.0`,
    // Work and school tenants let admins put any address in the email claim, so it
    // only counts when Microsoft marks the domain as verified (the xms_edov optional
    // claim). Personal accounts always own their address.
    verifiedEmail: (c) => {
      if (typeof c.email !== "string") return { error: "Microsoft didn't share an email for that account." };
      if (c.tid === MSA_TENANT || c.xms_edov === true || c.xms_edov === "1" || c.xms_edov === 1) return { email: c.email };
      return { error: "Your organization hasn't verified that email's domain with Microsoft. Sign in with an emailed code instead." };
    },
  },
};

const COOKIE = "sso";
const STATE_TTL_S = 10 * 60;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256b64url = async (s: string) => b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));

function decodeJwtPayload(jwt: string): Claims | null {
  try {
    const part = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part), (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

function enabled(env: Env, p: Provider): boolean {
  return !!(p.clientId(env) && p.clientSecret(env));
}

/** Which buttons the sign-in screen should show. */
export function ssoProviders(env: Env): { id: string; label: string }[] {
  return Object.entries(PROVIDERS).filter(([, p]) => enabled(env, p)).map(([id, p]) => ({ id, label: p.label }));
}

const callbackUrl = (req: Request, id: string) => `${new URL(req.url).origin}/tasks/api/auth/sso/${id}/callback`;

function cookie(req: Request, value: string, maxAge: number): string {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  // Lax is enough: the provider sends the user back with a top-level GET.
  return `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/tasks/api/auth/sso; Max-Age=${maxAge}${secure}`;
}

/** Send the user back to the app, with an error for the sign-in screen when there is one. */
function back(req: Request, next: string | null, error?: string, setCookie?: string): Response {
  const url = new URL(error ? "/tasks/" : (next ?? "/tasks/"), req.url);
  if (error) {
    url.searchParams.set("login_error", error);
    if (next) url.searchParams.set("next", next);
  }
  const headers = new Headers({ Location: url.toString(), "Cache-Control": "no-store" });
  headers.append("Set-Cookie", cookie(req, "", 0));
  if (setCookie) headers.append("Set-Cookie", setCookie);
  return new Response(null, { status: 302, headers });
}

async function start(req: Request, env: Env, id: string, p: Provider): Promise<Response> {
  const next = safeNext(new URL(req.url).searchParams.get("next"));
  const state = random();
  const verifier = random();
  const nonce = random(16);
  const url = new URL(p.authorize);
  url.search = new URLSearchParams({
    client_id: p.clientId(env)!,
    response_type: "code",
    redirect_uri: callbackUrl(req, id),
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: await sha256b64url(verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  const saved = b64url(new TextEncoder().encode(JSON.stringify({ id, state, verifier, nonce, next })));
  return new Response(null, { status: 302, headers: { Location: url.toString(), "Set-Cookie": cookie(req, saved, STATE_TTL_S), "Cache-Control": "no-store" } });
}

async function callback(req: Request, env: Env, id: string, p: Provider): Promise<Response> {
  const q = new URL(req.url).searchParams;
  let saved: { id: string; state: string; verifier: string; nonce: string; next: string | null } | null = null;
  try {
    const raw = (req.headers.get("Cookie") ?? "").split(";").map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (raw) saved = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
  } catch { /* treated as missing */ }
  const next = safeNext(saved?.next);

  // The state must match what this browser started with; otherwise someone could
  // push their own account into the victim's browser.
  if (!saved || saved.id !== id || !q.get("state") || q.get("state") !== saved.state) {
    return back(req, next, "That sign-in link expired. Try again.");
  }
  if (q.get("error")) return back(req, next, q.get("error") === "access_denied" ? `${p.label} sign-in was cancelled.` : `${p.label} sign-in failed.`);
  const code = q.get("code");
  if (!code) return back(req, next, `${p.label} sign-in failed.`);

  // The ID token comes straight from the provider's token endpoint over TLS,
  // authenticated with our client secret, so its signature doesn't need a separate
  // check (OpenID Connect Core 3.1.3.7). The claims below still do.
  const r = await fetch(p.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl(req, id),
      client_id: p.clientId(env)!,
      client_secret: p.clientSecret(env)!,
      code_verifier: saved.verifier,
    }),
  });
  const body = (await r.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
  if (!r.ok || !body.id_token) {
    console.error(`${id} token exchange failed`, r.status, body.error, body.error_description);
    return back(req, next, `${p.label} sign-in failed. Try again.`);
  }
  const claims = decodeJwtPayload(body.id_token);
  const now = Date.now() / 1000;
  if (
    !claims || claims.aud !== p.clientId(env) || !p.issuerOk(claims.iss, claims) ||
    claims.nonce !== saved.nonce || typeof claims.exp !== "number" || claims.exp < now - 60
  ) {
    console.error(`${id} id_token rejected`, claims?.iss, claims?.aud);
    return back(req, next, `${p.label} sign-in failed. Try again.`);
  }

  const v = p.verifiedEmail(claims);
  if ("error" in v) return back(req, next, v.error);
  const email = normalizeEmail(v.email);
  if (!email) return back(req, next, `${p.label} didn't share a usable email.`);
  if (!allowed(env, email)) return back(req, next, "This board is invite-only, and that email isn't on the list.");

  return back(req, next, undefined, await createSession(req, env, email));
}

/** /api/auth/sso/<provider> starts a sign-in; /api/auth/sso/<provider>/callback finishes it. */
export async function handleSso(req: Request, env: Env, path: string): Promise<Response | null> {
  if (path === "/api/auth/providers" && req.method === "GET") {
    // Everything the sign-in screen needs to render: SSO buttons and the Turnstile widget.
    return Response.json({
      providers: ssoProviders(env),
      turnstile: turnstileEnabled(env) ? { sitekey: env.TURNSTILE_SITEKEY, action: TURNSTILE_ACTION } : null,
    });
  }
  const m = /^\/api\/auth\/sso\/([a-z]+)(\/callback)?$/.exec(path);
  if (!m || req.method !== "GET") return null;
  const p = PROVIDERS[m[1]];
  if (!p || !enabled(env, p)) return Response.json({ error: "Unknown sign-in provider" }, { status: 404 });
  return m[2] ? callback(req, env, m[1], p) : start(req, env, m[1], p);
}
