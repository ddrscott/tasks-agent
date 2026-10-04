// The admin page at /tasks/admin: every account, and two switches on each. Admin lets that
// person open this page; Pro gives them the Pro plan without a subscription. The server checks
// the role on every call (src/users.ts), so this page is only the buttons.

import { useCallback, useEffect, useState } from "react";
import type { AdminUser } from "../users";
import { api, BASE } from "./base";
import { Footer } from "./Footer";
import { useTitle } from "./title";

type State = { users: AdminUser[]; more: boolean } | { error: string } | null;

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : null);

/** Why this account is on the plan it's on, in a few words. */
function planNote(u: AdminUser): string {
  if (u.stripe && u.plan === "pro" && !u.proGrant) return `paying (Stripe: ${u.stripe})`;
  if (u.stripe && u.proGrant) return `Pro given by an admin · Stripe: ${u.stripe}`;
  if (u.proGrant) return "Pro given by an admin";
  return u.stripe ? `Stripe: ${u.stripe}` : "";
}

export function Admin({ me, onBack }: { me: string; onBack(): void }) {
  useTitle("Admin");
  const [state, setState] = useState<State>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const [email, setEmail] = useState("");

  const load = useCallback(async () => {
    const r = await fetch(api("/api/admin/users"));
    const body = (await r.json().catch(() => ({}))) as { users?: AdminUser[]; more?: boolean; error?: string };
    setState(r.ok && body.users ? { users: body.users, more: !!body.more } : { error: r.status === 403 ? "This page is for admins." : body.error ?? "Couldn't load the accounts." });
  }, []);
  useEffect(() => { void load(); }, [load]);

  /** Set one flag on one account, then show the row the server sent back. */
  async function set(target: string, change: { admin?: boolean; pro?: boolean }, say: string) {
    setBusy(target);
    setNote(null);
    try {
      const r = await fetch(api("/api/admin/users"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: target, ...change }) });
      const body = (await r.json().catch(() => ({}))) as { user?: AdminUser; error?: string };
      if (!r.ok || !body.user) { setNote({ text: body.error ?? "That didn't work.", bad: true }); return false; }
      const user = body.user;
      setState((s) => (s && "users" in s ? { ...s, users: s.users.some((u) => u.email === user.email) ? s.users.map((u) => (u.email === user.email ? user : u)) : [user, ...s.users] } : s));
      setNote({ text: say });
      return true;
    } finally {
      setBusy(null);
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const target = email.trim().toLowerCase();
    if (!target) return;
    // No flags: this only puts the account on the list, where the switches are.
    if (await set(target, {}, `${target} is on the list. Use the switches on its row.`)) setEmail("");
  }

  return (
    <div className="connect">
      <header className="topbar">
        <h1 className="wordmark">tasks<span>.</span></h1>
        <span className="spacer" />
        <a className="btn" href={`${BASE}/`} onClick={(e) => { e.preventDefault(); onBack(); }}>← Back to Tasks</a>
      </header>
      <main className="connect-body admin">
        <section className="connect-intro">
          <h2 className="h">ADMIN</h2>
          <p className="lede">Who's an admin, and who's on Pro.</p>
          <p>Admin lets someone open this page and change these switches. Pro gives them the Pro plan without a subscription; a paid subscription counts on its own. That's all an admin can do here: nobody's board can be read from this page.</p>
        </section>

        {state === null && <p className="muted">loading accounts</p>}
        {state && "error" in state && <p className="admin-note bad" role="alert">{state.error}</p>}
        {state && "users" in state && (
          <>
            <form className="admin-add" onSubmit={(e) => void add(e)}>
              <label htmlFor="admin-email">Add someone by email, before they've signed in</label>
              <div className="admin-add-row">
                <input id="admin-email" className="field" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" autoComplete="off" />
                <button className="btn" disabled={!email.trim() || busy !== null}>Add</button>
              </div>
            </form>

            {/* Always in the page, so a screen reader hears each result. */}
            <p className={`admin-note${note?.bad ? " bad" : ""}`} role="status">{note?.text ?? ""}</p>

            <section className="admin-users" aria-label="Accounts">
              <h3 className="h">ACCOUNTS <span className="admin-count">{state.users.length}{state.more ? "+" : ""}</span></h3>
              <ul>
                {state.users.map((u) => {
                  const isAdmin = u.role === "admin";
                  const self = u.email === me;
                  // The server refuses both of these too; the button just says so up front.
                  const lockedAdmin = u.root || (self && isAdmin);
                  const why = u.root ? "A root admin, set in ADMIN_EMAILS. Change it there." : "You can't take your own admin role away.";
                  const seen = when(u.lastSeenAt);
                  return (
                    <li key={u.email} aria-busy={busy === u.email}>
                      <div className="admin-who">
                        <span className="admin-email">{u.email}</span>
                        {self && <span className="chip">you</span>}
                        {u.root && <span className="chip">root</span>}
                        <span className="admin-meta">
                          {seen ? `last signed in ${seen}` : "hasn't signed in yet"}
                          {planNote(u) && ` · ${planNote(u)}`}
                          {u.changedBy && ` · changed by ${u.changedBy === me ? "you" : u.changedBy}${when(u.changedAt) ? `, ${when(u.changedAt)}` : ""}`}
                        </span>
                      </div>
                      <div className="admin-switches">
                        <button
                          type="button" className="admin-switch" aria-pressed={isAdmin} disabled={busy !== null || lockedAdmin}
                          title={lockedAdmin ? why : isAdmin ? `Take admin away from ${u.email}` : `Make ${u.email} an admin`}
                          onClick={() => void set(u.email, { admin: !isAdmin }, isAdmin ? `${u.email} is no longer an admin.` : `${u.email} is an admin now.`)}
                        >{isAdmin && <span className="admin-mark" aria-hidden="true">$</span>}Admin</button>
                        <button
                          type="button" className="admin-switch" aria-pressed={u.proGrant} disabled={busy !== null}
                          title={u.proGrant ? `Take the Pro grant back from ${u.email}` : `Give ${u.email} Pro`}
                          onClick={() => void set(u.email, { pro: !u.proGrant }, u.proGrant ? `Took the Pro grant back from ${u.email}.` : `${u.email} is on Pro now.`)}
                        >{u.proGrant && <span className="admin-mark" aria-hidden="true">$</span>}Pro</button>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {state.more && <p className="muted">Only the 500 most recent accounts are listed.</p>}
            </section>
          </>
        )}
      </main>
      <Footer />
    </div>
  );
}
