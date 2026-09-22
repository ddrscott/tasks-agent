// Turnstile on the email sign-in form, so bots can't create accounts or use the form
// to send sign-in emails to strangers. The browser gets a single-use token from the
// widget, and the Worker checks it with Siteverify before sending any email.
// Google and Microsoft sign-in are redirects to those providers, which do their own
// bot checks, so they don't need it.

export const TURNSTILE_ACTION = "signin";

/** True when the form must carry a Turnstile token. */
export const turnstileEnabled = (env: Env) => !!env.TURNSTILE_SITEKEY;

/** Verify a token from the sign-in form. Fails closed on any error. */
export async function verifyTurnstile(req: Request, env: Env, token: unknown): Promise<boolean> {
  if (!turnstileEnabled(env)) return true;
  const hostnames = new Set((env.TURNSTILE_HOSTNAMES ?? "").split(",").map((h) => h.trim()).filter(Boolean));
  if (typeof token !== "string" || !token || token.length > 2048 || !env.TURNSTILE_SECRET || hostnames.size === 0) return false;

  let result: { success?: boolean; action?: string; hostname?: string; metadata?: { result_with_testing_key?: boolean } };
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET,
        response: token,
        remoteip: req.headers.get("CF-Connecting-IP") ?? "",
      }),
    });
    if (!r.ok) throw new Error(`siteverify ${r.status}`);
    result = await r.json();
  } catch (e) {
    console.error("turnstile siteverify failed", (e as Error).message);
    return false;
  }
  if (result.success !== true) return false;
  // Cloudflare's test keys answer with hostname "example.com" and no action. Accept
  // them only in local dev; production uses a real secret, which never returns this.
  if (result.metadata?.result_with_testing_key) return env.DEV_LOGIN_CODES === "1";
  return result.action === TURNSTILE_ACTION && !!result.hostname && hostnames.has(result.hostname);
}
