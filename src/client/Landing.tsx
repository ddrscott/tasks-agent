// What a signed-out visitor sees at /tasks/: what Tasks is, the sign-in form, and a picture of
// the product. The picture is the app's own components and CSS fed sample data, not a bitmap,
// so it follows the theme and can't drift from what the board really looks like.

import { useEffect, useState, type ReactNode } from "react";
import type { Plans, PlanPrice } from "../billing";
import type { Claim, Session } from "../presence-shared";
import type { Card } from "../shared";
import { api, BASE } from "./base";
import { CardFace } from "./Board";
import { claudeMcpAdd, CopyButton } from "./Connect";
import { Footer } from "./Footer";
import { IconSessions } from "./icons";
import { blockedSessions, isStale, PresenceContext, SessionRow } from "./Sessions";

const DEMO = `${BASE}/demo`;

export function Landing({ signIn }: { signIn: ReactNode }) {
  const command = claudeMcpAdd(`${location.origin}${BASE}/mcp`);
  return (
    <div className="landing">
      <header className="topbar">
        <p className="wordmark">tasks<span>.</span></p>
        <span className="spacer" />
        <nav className="landing-nav" aria-label="On this page">
          <a href={DEMO}>Demo</a>
          <a href="#connect">Connect</a>
          <a href="#pricing">Pricing</a>
          <a className="landing-nav-signin" href="#sign-in">Sign in</a>
        </nav>
      </header>

      <main>
        <section className="landing-hero">
          <div className="landing-pitch">
            <h1>The task board your coding agents work from.</h1>
            <p className="landing-sub">
              Claude Code, Cursor, Codex, or anything else that speaks MCP picks up cards and claims them.
              When one needs a decision it asks on the card, and you answer with one tap.
            </p>
            <p className="landing-try">
              <a className="btn primary" href={DEMO}>Try the demo board</a>
              <span>No sign-up needed.</span>
            </p>
            {signIn}
          </div>
          <Shot />
        </section>

        <section className="landing-section" aria-labelledby="different-h">
          <h2 className="h" id="different-h">WHATS_DIFFERENT</h2>
          <ol className="landing-points">
            <li>
              <h3>Agents ask. You answer in one tap.</h3>
              <p>
                An agent that needs a call from you puts the question on the card with two to four options
                and marks the one it would pick. Tap one. The answer goes on the card and out on the event
                feed, so the agent picks it up and keeps going.
              </p>
            </li>
            <li>
              <h3>See every session, and which ones need you.</h3>
              <p>
                Claude Code sessions report in through hooks: working, waiting on you, or idle, with the
                machine and the last thing each one did. A claimed card shows who has it, so two agents
                don't grab the same work.
              </p>
            </li>
            <li>
              <h3>Any MCP client connects with one command.</h3>
              <p>
                It's a plain MCP server over HTTP with OAuth sign-in. Claude Code, Claude, ChatGPT, Cursor,
                VS Code, and Codex each have setup steps on the Connect page. Nothing to install or host.
              </p>
            </li>
            <li>
              <h3>End-to-end encryption, if you want it.</h3>
              <p>
                Set a passphrase and the board is encrypted in your browser. We store only ciphertext, in an
                open format (JWE). The trade-off: an encrypted board is closed to outside agents, because the
                server can't read it either.
              </p>
              <p className="landing-aside"><span className="prompt">$</span> Forgot your passphrase? <b>#sorry-not-sorry</b> We can't get your data back either.</p>
            </li>
          </ol>
        </section>

        <section className="landing-section" id="connect" aria-labelledby="connect-h">
          <h2 className="h" id="connect-h">CONNECT_AN_AGENT</h2>
          <p className="landing-lede">One command puts Claude Code on your board.</p>
          <div className="copy-row">
            <code className="mono-box live">{command}</code>
            <CopyButton text={command} />
          </div>
          <p className="landing-note">
            Then run <code>/mcp</code> in Claude Code, pick <b>tasks</b>, and choose <b>Authenticate</b>. Your browser
            opens here to sign in and allow it. Tag a card <code>#agent</code> and tell the agent to work the board.
            Cursor, VS Code, Codex, ChatGPT, and Claude have their own steps on
            the <a href={`${BASE}/connect`}>Connect page</a>, with a starter prompt to paste in. You can read it all before you sign up.
          </p>
        </section>

        <Pricing />

        <section className="landing-section landing-last">
          <p className="landing-lede">Look before you sign up.</p>
          <p className="landing-try">
            <a className="btn primary" href={DEMO}>Try the demo board</a>
            <a className="btn" href="#sign-in">Sign in</a>
          </p>
        </section>
      </main>
      <Footer />
    </div>
  );
}

// ---------- the picture ----------

// One fixed moment, so the picture reads the same on every load: "4s ago" stays 4s ago.
const NOW = Date.parse("2026-10-01T15:04:05Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const card = (id: string, title: string, more: Partial<Card> = {}): Card => ({
  id, title, notes: "", laneId: "sample", due: null, createdAt: at(86_400_000), updatedAt: at(60_000), ...more,
});

const TODO: Card[] = [
  card("s1", "Write the 1.4 release notes", { tags: ["agent"] }),
  card("s2", "Flaky test in the checkout spec", { tags: ["agent"], notes: "Fails about one run in ten on CI." }),
  card("s3", "Renew the staging TLS cert"),
];

const DOING: Card[] = [
  card("s4", "Rate limit the login endpoint", {
    tags: ["agent", "needs-ceo"],
    ask: {
      question: "Limit by IP or by account?",
      options: ["By IP", "By account", "Both, IP first"],
      recommended: 2,
      askedAt: at(120_000),
    },
  }),
  card("s5", "Move the sessions table to D1", { tags: ["agent"] }),
];

const session = (id: string, more: Partial<Session>): Session => ({
  id, project: "checkout-api", machine: "macbook", agent: "lead", state: "working", last: "", cwd: "~/code/checkout-api", link: "",
  startedAt: NOW - 3_600_000, seenAt: NOW, ...more,
});

const SESSIONS: Session[] = [
  session("7c1e04b2-sample", { state: "needs-input", machine: "mini", last: "Waiting on: Limit by IP or by account?", seenAt: NOW - 120_000 }),
  session("3fa9d6e1-sample", { last: "Edit migrations/0007_sessions.sql", seenAt: NOW - 4_000 }),
  session("b20c88a7-sample", { project: "docs-site", agent: "", state: "idle", last: "Finished: rebuilt the search index", cwd: "~/code/docs-site", seenAt: NOW - 180_000 }),
];

const CLAIMS: Claim[] = [
  { cardId: "s4", sessionId: SESSIONS[0].id, agent: "lead", claimedAt: NOW - 600_000 },
  { cardId: "s5", sessionId: SESSIONS[1].id, agent: "lead", claimedAt: NOW - 900_000 },
];

const PRESENCE = { sessions: SESSIONS, claims: CLAIMS, now: NOW };
// The top bar's two counts, by the app's own rules: "need you" is open questions plus sessions
// stopped at a prompt, and Sessions is the ones that are live.
const NEED_YOU = [...TODO, ...DOING].filter((c) => c.ask).length + blockedSessions(SESSIONS, NOW).length;
const LIVE = SESSIONS.filter((s) => !isStale(s, NOW)).length;
const titleOf = (id: string) => [...TODO, ...DOING].find((c) => c.id === id)?.title;

function SampleLane({ name, index, cards }: { name: string; index: number; cards: Card[] }) {
  return (
    <section className="lane" style={{ ["--lane-color" as string]: `var(--lane-${index + 1})` }}>
      <header className="lane-head">
        <span className="lane-dot" />
        <span className="lane-name">{name}</span>
        <span className="lane-count">{cards.length}</span>
      </header>
      <div className="cards">
        {cards.map((c) => <CardFace key={c.id} card={c} isDone={false} />)}
      </div>
    </section>
  );
}

/**
 * A small board with sample data: a question waiting on a card, a claimed card, and the Sessions
 * list. It's `inert`, so nothing in it takes a click or a tab stop; the demo board is the one to
 * play with. Screen readers get one sentence instead of a pile of dead buttons.
 */
function Shot() {
  const groups = [...new Set(SESSIONS.map((s) => s.project))];
  return (
    <figure className="shot">
      <div className="shot-frame" role="img" aria-label="A sample board. A card in Doing carries an agent's question, Limit by IP or by account, with three options and one marked recommended. Another card shows the session working on it. A Sessions list shows one session waiting on you, one working, and one idle.">
        <div className="shot-inner" inert aria-hidden="true">
          <PresenceContext.Provider value={PRESENCE}>
            <div className="topbar">
              <span className="wordmark">tasks<span>.</span></span>
              <span className="spacer" />
              <span className="btn asks-btn"><span className="asks-count">?{NEED_YOU}</span><span className="label">need{NEED_YOU === 1 ? "s" : ""} you</span></span>
              <span className="btn sess-btn"><IconSessions /><span className="label">Sessions</span><span className="sess-count">{LIVE}</span></span>
            </div>
            <div className="shot-body">
              <SampleLane name="To do" index={0} cards={TODO} />
              <SampleLane name="Doing" index={1} cards={DOING} />
              <div className="sessions">
                <h2 className="h">SESSIONS</h2>
                {groups.map((project) => {
                  const list = SESSIONS.filter((s) => s.project === project);
                  return (
                    <section key={project}>
                      <h3 className="sess-project">{project}<span>{list.length}</span></h3>
                      <ul>
                        {list.map((s) => (
                          <SessionRow
                            key={s.id} session={s} now={NOW}
                            cards={CLAIMS.filter((c) => c.sessionId === s.id).map((c) => titleOf(c.cardId)).filter((t): t is string => !!t)}
                          />
                        ))}
                      </ul>
                    </section>
                  );
                })}
              </div>
            </div>
          </PresenceContext.Provider>
        </div>
      </div>
      <figcaption>
        Sample data, drawn with the app's own components. <a href={DEMO}>Try the demo board</a> to click around.
      </figcaption>
    </figure>
  );
}

// ---------- pricing ----------

/** Stripe quotes the smallest unit (cents); Intl knows how many of those make one of the currency. */
function money(p: PlanPrice): string {
  const fmt = new Intl.NumberFormat(undefined, { style: "currency", currency: p.currency.toUpperCase() });
  const digits = fmt.resolvedOptions().maximumFractionDigits ?? 2;
  const value = p.amount / 10 ** digits;
  return new Intl.NumberFormat(undefined, {
    style: "currency", currency: p.currency.toUpperCase(), minimumFractionDigits: Number.isInteger(value) ? 0 : digits,
  }).format(value);
}

const every = (p: PlanPrice) => (p.intervalCount === 1 ? `a ${p.interval}` : `every ${p.intervalCount} ${p.interval}s`);

/**
 * Free and Pro, readable without an account. Every number comes from GET /api/plans: the caps
 * from the Worker's config and the price from Stripe. With billing off there's no Pro to quote,
 * and the page says so instead of making one up.
 */
function Pricing() {
  const [plans, setPlans] = useState<Plans | null | "failed">(null);
  useEffect(() => {
    fetch(api("/api/plans")).then((r) => (r.ok ? (r.json() as Promise<Plans>) : Promise.reject(new Error(String(r.status)))))
      .then(setPlans).catch(() => setPlans("failed"));
  }, []);

  const loaded = plans && plans !== "failed" ? plans : null;
  const chats = (n: number | undefined) => (n === undefined ? "…" : n.toLocaleString());
  return (
    <section className="landing-section" id="pricing" aria-labelledby="pricing-h">
      <h2 className="h" id="pricing-h">PRICING</h2>
      <p className="landing-lede">The board and MCP are free and never capped.</p>
      <p className="landing-note">
        Your own agents can read and change the board as much as they like on either plan. The one thing
        with a daily limit is the assistant built into the board, because that's the part that runs on our model bill.
      </p>
      {plans === "failed" ? (
        <p className="landing-note" role="alert">The plan details didn't load. Refresh to try again.</p>
      ) : (
        <div className="plans">
          <div className="plan">
            <h3>Free</h3>
            {/* Zero in Pro's currency when Stripe has told us one; otherwise words, not a guessed currency. */}
            <p className="plan-price">
              {loaded?.pro?.price ? <b>{money({ ...loaded.pro.price, amount: 0 })}</b> : <span>{loaded ? "No charge, no card." : "…"}</span>}
            </p>
            <ul>
              <li><b>{chats(loaded?.free.dailyChats)}</b> assistant messages a day</li>
              <li>Unlimited cards, lanes, and MCP calls</li>
              <li>Questions, sessions, search, attachments, encryption</li>
            </ul>
          </div>
          {loaded?.pro && (
            <div className="plan">
              <h3>Pro</h3>
              <p className="plan-price">
                {loaded.pro.price
                  ? <><b>{money(loaded.pro.price)}</b> {every(loaded.pro.price)}</>
                  : <span>The price is shown at checkout.</span>}
              </p>
              <ul>
                <li><b>{chats(loaded.pro.dailyChats)}</b> assistant messages a day</li>
                <li>Everything in Free, same as it is there</li>
                <li>Upgrade or cancel from the account menu, through Stripe</li>
              </ul>
            </div>
          )}
        </div>
      )}
      {loaded && !loaded.pro && (
        <p className="landing-note">Pro isn't on sale yet. When it is, the price will be listed here.</p>
      )}
    </section>
  );
}
