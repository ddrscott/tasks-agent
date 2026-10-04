// The page an invite email's link opens: /tasks/invite#t=<token> (// TEAM_BOARDS in the README).
// This is the plain working version: it looks the invite up, shows who sent it and the role, and
// accepts or declines. The token is in the fragment, so it never reaches the server in a URL.

import { useEffect, useState } from "react";
import { api, BASE } from "./base";
import { useTitle } from "./title";

type InviteInfo = { board: string; ownerEmail: string; email: string; role: "viewer" | "writer"; expiresAt: number };
const tokenFromHash = () => new URLSearchParams(location.hash.slice(1)).get("t") ?? "";

async function post<T>(path: string, body: unknown): Promise<{ ok: boolean; data: T & { error?: string } }> {
  const r = await fetch(api(path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { ok: r.ok, data: (await r.json().catch(() => ({}))) as T & { error?: string } };
}

export function Invite({ me, onBoard }: { me: { email: string } | null; onBoard(board: string): void }) {
  useTitle("Board invite");
  const [token] = useState(tokenFromHash);
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!me || !token) return;
    void post<{ invite?: InviteInfo }>("/api/invites/lookup", { token }).then(({ ok, data }) => {
      if (ok && data.invite) setInvite(data.invite);
      else setNote(data.error ?? "This invite isn't for this account, or it's no longer valid.");
    });
  }, [me, token]);

  async function answer(kind: "accept" | "decline") {
    setBusy(true);
    const { ok, data } = await post<{ board?: { id: string } }>(`/api/invites/${kind}`, { token });
    setBusy(false);
    if (!ok) { setInvite(null); setNote(data.error ?? "That didn't work."); return; }
    if (kind === "accept" && data.board) onBoard(data.board.id);
    else { setInvite(null); setNote("Declined. Nothing was shared with you."); }
  }

  // Back here after sign-in, token and all. `next` only takes paths inside the app (safeNext).
  const signIn = `${BASE}/?next=${encodeURIComponent(`${BASE}/invite#t=${token}`)}`;
  return (
    <main className="legal">
      <section className="connect-intro">
        <h2 className="h">BOARD_INVITE</h2>
        {!token && <p>This link is missing its invite. Open it again from the email.</p>}
        {token && !me && <p>Sign in as the address the invite was sent to. <a className="btn" href={signIn}>Sign in</a></p>}
        {me && invite && (
          <>
            <p><b>{invite.ownerEmail}</b> invited you to their board as a <b>{invite.role}</b> ({invite.role === "viewer" ? "you can read it, not change it" : "you can add, edit, and move cards"}).</p>
            <p className="muted">Signed in as {me.email}.</p>
            <p>
              <button className="btn primary" disabled={busy} onClick={() => void answer("accept")}>Accept</button>{" "}
              <button className="btn" disabled={busy} onClick={() => void answer("decline")}>Decline</button>
            </p>
          </>
        )}
        {me && note && <p role="status">{note} <span className="muted">Signed in as {me.email}.</span></p>}
        <p><a href={`${BASE}/`}>Go to your board</a></p>
      </section>
    </main>
  );
}
