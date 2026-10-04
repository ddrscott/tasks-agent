import { BASE } from "./base";
import { Footer } from "./Footer";
import { useTitle } from "./title";

/** Every address the app answers under /tasks/. Anything else gets the not-found page. */
const KNOWN = ["", "connect", "privacy", "terms", "demo"];

/** Whether the address bar names a page that doesn't exist. */
export const isUnknownPath = () => !KNOWN.includes(location.pathname.replace(/\/+$/, "").slice(BASE.length + 1));

/** Shown for a mistyped or stale link, signed in or not. The links are plain ones, so they load the real page. */
export function NotFound() {
  useTitle("Not found");
  return (
    <div className="connect">
      <header className="topbar">
        <p className="wordmark">tasks<span>.</span></p>
        <span className="spacer" />
        <a className="btn" href={`${BASE}/`}>← Back to Tasks</a>
      </header>
      <main className="connect-body">
        <section className="connect-intro">
          <h1 className="h">NOT_FOUND</h1>
          <p className="lede">There's no page at this address.</p>
          <div className="copy-row"><code className="mono-box live">GET {location.pathname} → 404</code></div>
          <p>The link may be old, or there's a typo in it. These are the pages that exist:</p>
        </section>
        <ul className="notfound-links">
          <li><a href={`${BASE}/`}>Your board</a><span>or the sign-in page, if you're signed out</span></li>
          <li><a href={`${BASE}/demo`}>The demo board</a><span>try it without an account</span></li>
          <li><a href={`${BASE}/connect`}>Connect an agent</a><span>setup for Claude Code, Cursor, and other MCP clients</span></li>
          <li><a href={`${BASE}/privacy`}>Privacy</a><span>what we keep and why</span></li>
          <li><a href={`${BASE}/terms`}>Terms</a><span>the rules for using Tasks</span></li>
        </ul>
      </main>
      <Footer />
    </div>
  );
}
