import { useEffect, useRef, useState } from "react";
import { PAGE_META, pageAt } from "../routes";
import { api, BASE } from "./base";
import { Footer } from "./Footer";
import { useTitle } from "./title";
import { Landing } from "./Landing";

async function post(path: string, body: unknown) {
  const r = await fetch(api(path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await r.json().catch(() => ({}))) as { error?: string; devCode?: string };
  if (!r.ok) throw new Error(data.error ?? "Something went wrong. Try again.");
  return data;
}

type Provider = { id: string; label: string };
type TurnstileConfig = { sitekey: string; action: string };

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: Record<string, unknown>): string;
      reset(id: string): void;
      remove(id: string): void;
    };
  }
}

let turnstileScript: Promise<void> | null = null;
function loadTurnstile(): Promise<void> {
  turnstileScript ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { turnstileScript = null; reject(new Error("Turnstile failed to load")); };
    document.head.appendChild(s);
  });
  return turnstileScript;
}

/**
 * Only return to paths inside the app, matching safeNext on the server. A fragment is cut off:
 * `next` is sent to the server and written into the sign-in email, and a fragment is where an
 * invite link keeps its token (Invite.tsx holds that in the tab instead).
 */
const safeNext = (raw: string | null) => {
  const path = raw?.split("#")[0];
  return path && path.startsWith("/tasks/") && !path.startsWith("//") && !/[\\\s]/.test(path) ? path : null;
};

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  // The front page keeps the full default title. At /tasks/pricing it's the pricing page, signed
  // out too, which is what the served HTML says (PAGE_META in src/routes.ts).
  useTitle(pageAt(location.pathname, BASE) === "pricing" ? PAGE_META.pricing.name : undefined);
  // Where to go after signing in, e.g. back to an agent's OAuth consent screen.
  const [next] = useState(() => safeNext(new URLSearchParams(location.search).get("next")));
  const [providers, setProviders] = useState<Provider[]>([]);
  // Turnstile guards sending codes. Tokens are single-use, so the widget resets after each send.
  const [turnstile, setTurnstile] = useState<TurnstileConfig | null>(null);
  const [human, setHuman] = useState(false);
  const [tsFailed, setTsFailed] = useState(false);
  const tsBox = useRef<HTMLDivElement>(null);
  const tsId = useRef<string | null>(null);
  const tsToken = useRef<string | null>(null);
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);
  // Focusing a field scrolls to it. On the landing page at phone width the form sits below the
  // pitch and the picture, and /tasks/pricing is headed for another section, so leave it alone there.
  const [focusEmail] = useState(() => !!next || (matchMedia("(min-width: 901px)").matches && pageAt(location.pathname, BASE) !== "pricing"));

  // The email link lands here as /?email=…&code=…; finish signing in automatically.
  // Google and Microsoft sign-in land here with ?login_error=… when they fail.
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const e = q.get("email");
    const c = q.get("code");
    const failed = q.get("login_error");
    // Drop the code from the address bar. A shared board's id stays (`?board=`), so a bookmark
    // of someone's board opens it once you've signed in.
    const board = q.get("board");
    history.replaceState(null, "", location.pathname + (board && /^[0-9a-f]{32}$/.test(board) ? `?board=${board}` : ""));
    if (failed) setError(failed.slice(0, 200));
    fetch(api("/api/auth/providers")).then((r) => r.json() as Promise<{ providers: Provider[]; turnstile: TurnstileConfig | null }>)
      .then((r) => { setProviders(r.providers); setTurnstile(r.turnstile); }).catch(() => {});
    if (e && c) {
      setEmail(e);
      setCode(c);
      setStep("code");
      void verify(e, c);
    }
  }, []);

  useEffect(() => {
    if (!turnstile || !tsBox.current) return;
    let cancelled = false;
    const setToken = (t: string | null) => { tsToken.current = t; setHuman(!!t); if (t) setTsFailed(false); };
    loadTurnstile().then(() => {
      if (cancelled || !tsBox.current || !window.turnstile) return;
      tsId.current = window.turnstile.render(tsBox.current, {
        sitekey: turnstile.sitekey,
        action: turnstile.action,
        appearance: "interaction-only", // invisible unless Cloudflare needs a click
        theme: getComputedStyle(document.documentElement).colorScheme === "light" ? "light" : "dark",
        callback: (t: string) => setToken(t),
        "expired-callback": () => setToken(null),
        // Turnstile keeps retrying on its own; say so instead of spinning silently.
        "error-callback": () => { setToken(null); setTsFailed(true); },
      });
    }).catch(() => setError("The human check didn't load. Refresh the page and try again."));
    return () => {
      cancelled = true;
      if (tsId.current) window.turnstile?.remove(tsId.current);
      tsId.current = null;
    };
  }, [turnstile]);

  function resetTurnstile() {
    tsToken.current = null;
    setHuman(false);
    if (tsId.current) window.turnstile?.reset(tsId.current);
  }

  const needsHuman = !!turnstile && !human;

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  useEffect(() => {
    if (step === "code") codeRef.current?.focus();
  }, [step]);

  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post("/api/auth/start", { email, next, turnstile: tsToken.current });
      setDevCode(r.devCode ?? null);
      setStep("code");
      setCooldown(30);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      resetTurnstile();
      setBusy(false);
    }
  }

  async function verify(e: string, c: string) {
    setBusy(true);
    setError(null);
    try {
      await post("/api/auth/verify", { email: e, code: c });
      if (next) location.assign(next);
      else onSignedIn();
    } catch (err) {
      setError((err as Error).message);
      setCode("");
      codeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  function onCode(v: string) {
    const digits = v.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    if (digits.length === 6) void verify(email, digits);
  }

  // Coming back from somewhere (an agent's OAuth consent screen), the page is just the form.
  // Everyone else gets the landing page, with this same form in it.
  const card = (
      <div className="login-card" id="sign-in">
        {next ? <h1 className="wordmark">tasks<span>.</span></h1> : <h2 className="h">SIGN_IN</h2>}
        {step === "email" ? (
          <>
            {next?.startsWith("/tasks/oauth/")
              ? <p>Sign in to connect an agent to your Tasks.</p>
              : next === `${BASE}/invite`
              ? <p>Sign in to open your board invite. Use the address the invite was sent to; it only works for that one.</p>
              : <p>{providers.length > 0 ? "Use an account you already have, or get a code by email." : "We email you a code."} There's no password to remember.</p>}
            {providers.length > 0 && (
              <>
                <div className="sso">
                  {providers.map((p) => (
                    <a key={p.id} className="btn sso-btn" href={api(`/api/auth/sso/${p.id}${next ? `?next=${encodeURIComponent(next)}` : ""}`)}>
                      <SsoMark id={p.id} />Continue with {p.label}
                    </a>
                  ))}
                </div>
                <div className="or"><span>or use your email</span></div>
              </>
            )}
            <form onSubmit={send}>
              <label className="sr-only" htmlFor="email">Email</label>
              <input
                id="email" className="field" type="email" required autoFocus={focusEmail} autoComplete="email"
                placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)}
              />
              <button className="btn primary" disabled={busy || !email || needsHuman}>
                {busy ? "Sending…" : needsHuman ? (tsFailed ? "Human check failed, retrying…" : "Checking you're human…") : "Email me a sign-in code"}
              </button>
            </form>
          </>
        ) : (
          <>
            <p>We sent a 6-digit code to <b>{email}</b>. Enter it below or click the link in the email.</p>
            <form onSubmit={(e) => { e.preventDefault(); void verify(email, code); }}>
              <label className="sr-only" htmlFor="code">Sign-in code</label>
              <input
                id="code" ref={codeRef} className="field code-input" inputMode="numeric" autoComplete="one-time-code"
                placeholder="······" value={code} onChange={(e) => onCode(e.target.value)} disabled={busy}
              />
              <button className="btn primary" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Sign in"}</button>
            </form>
            {devCode && <div className="login-note">dev mode · your code is <b>{devCode}</b></div>}
            <div className="login-foot">
              <button className="linkish" onClick={() => { setStep("email"); setCode(""); setError(null); }}>Use a different email</button>
              <button className="linkish" disabled={cooldown > 0 || busy || needsHuman} onClick={() => send()}>
                {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
              </button>
            </div>
          </>
        )}
        {error && <div className="login-error" role="alert">{error}</div>}
        {tsFailed && !error && (
          <div className="login-note">The human check couldn't finish. It retries on its own{providers.length > 0 ? ", or continue with an account above" : ""}.</div>
        )}
        {/* Stays mounted across both steps so "Resend code" gets a fresh token too. */}
        {turnstile && <div ref={tsBox} className="turnstile-box" />}
      </div>
  );
  if (!next) return <Landing signIn={card} />;
  return (
    <main className="login">
      <div className="login-stack">{card}</div>
      <Footer />
    </main>
  );
}

function SsoMark({ id }: { id: string }) {
  if (id === "google") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7z" />
        <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
        <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4-3.1z" />
        <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.8 3.6-4.9 6.7-4.9z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#F25022" d="M1 1h10.5v10.5H1z" /><path fill="#7FBA00" d="M12.5 1H23v10.5H12.5z" />
      <path fill="#00A4EF" d="M1 12.5h10.5V23H1z" /><path fill="#FFB900" d="M12.5 12.5H23V23H12.5z" />
    </svg>
  );
}
