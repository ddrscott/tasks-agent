// The page an invite email's link opens: /tasks/invite#t=<token> (// TEAM_BOARDS in the README).
//
// The token is in the fragment, so it never reaches the server in a URL. This page keeps it
// that way through sign-in: it moves the token into this tab's sessionStorage, takes it out of
// the address bar, and sends you to sign in with `next=/tasks/invite`, no token in it. Email
// code, Google, or Microsoft, you land back here in the same tab and the token is still in the
// tab. It's only ever sent in the body of the three invite calls, and it's cleared once the
// invite is answered or you leave the page for your board (closing the tab clears it too). A
// sign-in link opened in another tab doesn't have it; that tab says to open the invite email again.
//
// The server gives one answer for every invite that can't be used: wrong account, used,
// withdrawn, expired, or made up. So does this page. Telling them apart would tell a stranger
// with a stolen link that it's real.

import { useEffect, useState } from "react";
import { api, BASE } from "./base";
import { Footer } from "./Footer";
import { ROLE_LINE } from "./member";
import { useTitle } from "./title";

type InviteInfo = { board: string; ownerEmail: string; email: string; role: "viewer" | "writer"; expiresAt: number };

const KEY = "tasks-invite";
/** Read by the board when it opens (App.tsx), so the first thing it says is where you are. */
const FLASH = "tasks-board-flash";

function takeToken(): string {
  const fromLink = new URLSearchParams(location.hash.slice(1)).get("t") ?? "";
  if (fromLink) {
    try {
      sessionStorage.setItem(KEY, fromLink);
      // It's held in the tab now, so it can come out of the address bar and the history.
      history.replaceState(null, "", location.pathname);
    } catch { /* no storage: it stays in the address, and still works if you're signed in */ }
    return fromLink;
  }
  try { return sessionStorage.getItem(KEY) ?? ""; } catch { return ""; }
}
const dropToken = () => { try { sessionStorage.removeItem(KEY); } catch { /* nothing to drop */ } };

async function post<T>(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const r = await fetch(api(path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, status: r.status, data: (await r.json().catch(() => ({}))) as T & { error?: string } };
}

const SIGN_IN = `${BASE}/?next=${encodeURIComponent(`${BASE}/invite`)}`;

type State =
  | { at: "checking" }
  | { at: "invite"; invite: InviteInfo }
  /** One state for every invite that can't be used by this account. */
  | { at: "no-good" }
  | { at: "declined"; ownerEmail: string }
  /** Too many tries, or the network: the server's own sentence. The token is kept, so trying again can work. */
  | { at: "later"; text: string };

export function Invite({ me, onSignedOut }: { me: { email: string } | null; onSignedOut(): void }) {
  useTitle("Board invite");
  const [token] = useState(takeToken);
  const [state, setState] = useState<State>({ at: "checking" });
  const [busy, setBusy] = useState<"accept" | "decline" | "signout" | null>(null);

  // Another invite link opened in this same tab only changes the fragment, which doesn't load
  // the page again. Start over with the new link.
  useEffect(() => {
    const onHash = () => { if (new URLSearchParams(location.hash.slice(1)).get("t")) location.reload(); };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!me || !token) return;
    let off = false;
    post<{ invite?: InviteInfo }>("/api/invites/lookup", { token }).then(({ ok, status, data }) => {
      if (off) return;
      if (ok && data.invite) setState({ at: "invite", invite: data.invite });
      // The token stays in the tab: "sign out and use another address" comes back here with it.
      else if (status === 404) setState({ at: "no-good" });
      else setState({ at: "later", text: data.error ?? "The invite couldn't be checked just now. Try again in a minute." });
    }).catch(() => { if (!off) setState({ at: "later", text: "The invite couldn't be checked just now. Try again in a minute." }); });
    return () => { off = true; };
  }, [me, token]);

  async function answer(kind: "accept" | "decline", invite: InviteInfo) {
    setBusy(kind);
    const r = await post<{ board?: { id: string; ownerEmail: string; role: string } }>(`/api/invites/${kind}`, { token }).catch(() => null);
    setBusy(null);
    if (!r) { setState({ at: "later", text: "That didn't go through. Check your connection and try again." }); return; }
    if (r.status === 404) { dropToken(); setState({ at: "no-good" }); return; }
    if (!r.ok) { setState({ at: "later", text: r.data.error ?? "That didn't go through. Try again in a minute." }); return; }
    dropToken();
    if (kind === "decline") { setState({ at: "declined", ownerEmail: invite.ownerEmail }); return; }
    const board = r.data.board?.id ?? invite.board;
    try { sessionStorage.setItem(FLASH, `You're on ${invite.ownerEmail}'s board as a ${invite.role}.`); } catch { /* the board's banner says it anyway */ }
    location.assign(`${BASE}/?board=${board}`);
  }

  // Sign out and come back here signed in as someone else. The token stays in this tab.
  async function switchAccount() {
    setBusy("signout");
    await fetch(api("/api/auth/logout"), { method: "POST" }).catch(() => {});
    onSignedOut();
    location.assign(SIGN_IN);
  }

  const home = <a className="btn" href={`${BASE}/`} onClick={dropToken}>Go to my board</a>;

  return (
    <main className="login invite-page">
      <div className="login-stack">
        <section className="login-card invite-card" aria-labelledby="invite-h">
          <a className="wordmark" href={`${BASE}/`} aria-label="Tasks">tasks<span>.</span></a>
          <h1 className="h" id="invite-h">BOARD_INVITE</h1>

          {!token && (
            <>
              <p>
                {me
                  ? <>There's no invite open in this tab. Open the link in your invite email again. You're signed in as <b className="mono">{me.email}</b>, so it'll go straight to the invite.</>
                  : "This link is missing its invite. Open it again from the invite email."}
              </p>
              <div className="invite-actions">{me ? home : <a className="btn" href={`${BASE}/`}>Go to Tasks</a>}</div>
            </>
          )}

          {token && !me && (
            <>
              <p>Someone invited you to their Tasks board. Sign in to see who, and what you'd be able to do there.</p>
              <p>An invite works for one email address only, so sign in as the address it was sent to. You'll come right back here.</p>
              <div className="invite-actions"><a className="btn primary" href={SIGN_IN}>Sign in to see the invite</a></div>
            </>
          )}

          {token && me && state.at === "checking" && <p className="invite-wait" role="status">checking the invite</p>}

          {token && me && state.at === "invite" && (
            <>
              <p><b className="mono">{state.invite.ownerEmail}</b> invited you to their board.</p>
              <dl className="invite-facts">
                <div><dt>From</dt><dd>{state.invite.ownerEmail}</dd></div>
                <div><dt>To</dt><dd>{state.invite.email}</dd></div>
                <div><dt>Role</dt><dd><span className="role-chip" data-role={state.invite.role}>{state.invite.role}</span></dd></div>
                <div><dt>Expires</dt><dd>{new Date(state.invite.expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</dd></div>
              </dl>
              <p>{ROLE_LINE[state.invite.role]}</p>
              <p className="invite-small">It's their whole board. You can leave it whenever you like, and they can change your role or remove you.</p>
              <div className="invite-actions">
                <button className="btn primary" disabled={!!busy} onClick={() => void answer("accept", state.invite)}>{busy === "accept" ? "Joining…" : "Accept"}</button>
                <button className="btn" disabled={!!busy} onClick={() => void answer("decline", state.invite)}>{busy === "decline" ? "Declining…" : "Decline"}</button>
              </div>
            </>
          )}

          {token && me && state.at === "no-good" && (
            <>
              <p role="alert"><b>This invite can't be used with {me.email}.</b></p>
              <p>
                Either it was sent to a different address, or it's already been used, was withdrawn, or has expired. An invite link works once,
                for seven days, and only for the address it was sent to.
              </p>
              <p>If it went to another address of yours, sign out and sign back in with that one. Otherwise ask the person who invited you for a new invite.</p>
              <div className="invite-actions">
                <button className="btn primary" disabled={!!busy} onClick={() => void switchAccount()}>{busy === "signout" ? "Signing out…" : "Sign out and use another address"}</button>
                {home}
              </div>
            </>
          )}

          {token && me && state.at === "declined" && (
            <>
              <p role="status"><b>Declined.</b> Nothing was shared with you, and {state.ownerEmail} can see that you declined.</p>
              <div className="invite-actions">{home}</div>
            </>
          )}

          {token && me && state.at === "later" && (
            <>
              <p role="alert">{state.text}</p>
              <div className="invite-actions">
                <button className="btn primary" onClick={() => location.reload()}>Try again</button>
                {home}
              </div>
            </>
          )}

          {me && <p className="login-note">Signed in as {me.email}.</p>}
        </section>
      </div>
      <Footer />
    </main>
  );
}
