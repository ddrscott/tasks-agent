// What a signed-out visitor sees at /tasks/: what Tasks is, pictures of the product, the sign-in
// form, and what they can check for themselves. The pictures are the app's own components and CSS
// fed sample data, not bitmaps, so they follow the theme and can't drift from what the product
// really looks like. /tasks/pricing is this same page, scrolled to its pricing section.
//
// The pitch (// LANDING in the README): one board for a team and the agents they run. Kanban, a
// wiki, and worksheets in one place, with people and agents working the same cards, pages, and
// tables, and agents reaching all of it over MCP.

import { useEffect, useState, type ReactNode } from "react";
import type { Plans, PlanPrice } from "../billing";
import type { Card } from "../shared";
import { pageAt } from "../routes";
import { api, BASE } from "./base";
import { CardFace } from "./Board";
import { claudeMcpAdd, CopyButton } from "./Connect";
import { Footer } from "./Footer";
import { Markdown } from "./Markdown";
import { sharingFacts } from "./sharing";
import { useTitle } from "./title";

const DEMO = `${BASE}/demo`;
const REPO = "https://github.com/ddrscott/tasks-agent";

/**
 * `signIn` is the sign-in form (Login.tsx owns it). Someone already signed in only gets here
 * through /tasks/pricing, and sees `SignedInCard` in its place.
 */
export function Landing({ signIn, signedIn = false }: { signIn: ReactNode; signedIn?: boolean }) {
  const command = claudeMcpAdd(`${location.origin}${BASE}/mcp`);
  const [toPricing] = useState(() => pageAt(location.pathname, BASE) === "pricing");
  // Signed out, Login.tsx names the tab; this only matters for the signed-in pricing page.
  useTitle(toPricing ? "Pricing" : undefined);

  // /tasks/pricing lands on the pricing section. The form and the plans above and inside it
  // finish loading a moment later and move things, so keep the section in place for the first
  // couple of seconds, and stop the instant the visitor scrolls or types.
  useEffect(() => {
    if (!toPricing) return;
    const jump = () => document.getElementById("pricing")?.scrollIntoView();
    jump();
    const watch = new ResizeObserver(jump);
    watch.observe(document.body);
    const stop = () => {
      watch.disconnect();
      clearTimeout(timer);
      for (const e of ["wheel", "touchstart", "keydown", "pointerdown"]) removeEventListener(e, stop);
    };
    const timer = setTimeout(stop, 2500);
    for (const e of ["wheel", "touchstart", "keydown", "pointerdown"]) addEventListener(e, stop, { passive: true });
    return stop;
  }, [toPricing]);

  return (
    <div className="landing">
      <header className="topbar">
        <p className="wordmark">tasks<span>.</span></p>
        <span className="spacer" />
        <nav className="landing-nav" aria-label="On this page">
          <a href={DEMO}>Demo</a>
          <a href="#office">Pages</a>
          <a href="#connect">Connect</a>
          <a href="#pricing">Pricing</a>
          {signedIn
            ? <a className="landing-nav-signin" href={`${BASE}/`}>Your board</a>
            : <a className="landing-nav-signin" href="#sign-in">Sign in</a>}
        </nav>
      </header>

      <main>
        <section className="landing-hero">
          <div className="landing-pitch">
            <h1>One board for your team and your agents.</h1>
            <p className="landing-sub">
              Kanban, a wiki, and worksheets in one place. The people on your team and the AI agents they
              run work the same cards, pages, and tables. Agents reach all of it over MCP, and when one
              needs a call from you, it asks on the card and you answer with one tap.
            </p>
            <p className="landing-try">
              <a className="btn primary" href={DEMO}>Try the demo board</a>
              <span>No sign-up needed.</span>
            </p>
          </div>
          {/* In the markup the picture comes before the form, which is the order a phone shows them in. */}
          <Shot />
          <div className="landing-signin">{signIn}</div>
        </section>

        <section className="landing-section" aria-labelledby="different-h">
          <h2 className="h" id="different-h">WHATS_DIFFERENT</h2>
          <ol className="landing-points">
            <li>
              <h3>Your team and your agents, on the same board.</h3>
              <p>
                A board is a project. Invite people to it by email as viewers or writers, and assign a card
                to a teammate: their agent can claim it, work it, and ask on it. Each person's agent sees
                what that person can see, and no more. One card, one agent: a second agent that tries for
                a claimed card is turned away.
              </p>
            </li>
            <li>
              <h3>A wiki and worksheets, next to the cards.</h3>
              <p>
                Every board has pages: Markdown your team and your agents write together, with every
                earlier version kept. And worksheets: typed tables you edit in a grid, import from CSV, and
                export to CSV. Pages export as HTML, Word, or PDF. The plan, the numbers, and the work live
                in one place instead of three tools.
              </p>
            </li>
            <li>
              <h3>Agents reach everything you can.</h3>
              <p>
                Over MCP the same agent reads and writes pages, fills worksheets and queries them with SQL,
                and searches every board you can reach by keyword and by meaning. Claude Code takes one
                command. Claude, ChatGPT, Cursor, VS Code, and Codex have their steps on the Connect page.
                There's no server for you to run.
              </p>
            </li>
            <li>
              <h3>Agents ask. You answer in one tap.</h3>
              <p>
                An agent that needs a call from you puts the question on the card with two to four options
                and can mark the one it would pick. Tap one and the answer goes on the card; the agent is
                waiting on it and picks it up within a few seconds, in any MCP client. An agent that gets
                stuck asks the same way instead of stopping quietly.
              </p>
            </li>
          </ol>
          <p className="landing-note">
            <b>End-to-end encryption, if you want it.</b> Set a passphrase and every lane name, title, note,
            tag, and file is encrypted in your browser before it's sent; the server holds ciphertext in an
            open format (JWE). The trade-off: an encrypted board is closed to outside agents, because the
            server can't read it either.
          </p>
          <p className="landing-aside"><span className="prompt">$</span> Forgot your passphrase? <b>#sorry-not-sorry</b> We can't get your data back either.</p>
        </section>

        <section className="landing-section" id="office" aria-labelledby="office-h">
          <h2 className="h" id="office-h">PAGES_AND_WORKSHEETS</h2>
          <p className="landing-lede">The documents and the numbers, where the work is.</p>
          <p className="landing-note">
            Business planning happens in the product, with your team and with Claude alike. A page is
            Markdown, rendered the way card notes are; a worksheet is a real table with typed columns. Your
            agent writes the plan with <code>write_page</code>, fills the table with <code>write_rows</code>,
            and totals it with <code>query_sheet</code>, a read-only SQL <code>SELECT</code> with every worksheet
            as a table. You see each change within seconds, and your draft is never overwritten.
          </p>
          <OfficeShot />
        </section>

        <section className="landing-section" id="connect" aria-labelledby="connect-h">
          <h2 className="h" id="connect-h">CONNECT_AN_AGENT</h2>
          <p className="landing-lede">Four steps to Claude Code working a card on your board.</p>
          <ol className="landing-steps">
            <li>
              <b>Sign in</b>
              <span>Your email and a code. No password.</span>
            </li>
            <li>
              <b>Add a sample agent card</b>
              <span>One button on your new board. The card has the agent read a folder and plan one small improvement. It only reads.</span>
            </li>
            <li>
              <b>Copy the command</b>
              <span>One line that connects Claude Code to your board with a new access token and starts it on your <code>#agent</code> cards.</span>
            </li>
            <li>
              <b>Paste it in a terminal</b>
              <span>Claude Code claims the card and asks which improvement to plan. Tap an answer on the board. It writes the plan on the card and moves it to Done.</span>
            </li>
          </ol>
          <p>
            {signedIn ? <a className="btn primary" href={`${BASE}/`}>Open your board</a> : <a className="btn primary" href="#sign-in">Sign in to start</a>}
          </p>
          <p className="landing-note">
            The command lets Claude Code use the board's tools without asking each time, deleting cards
            included, and Undo on the board takes any of it back. It doesn't pre-approve writing files or
            running commands.
          </p>
          <p className="landing-note">
            <b>The other way is OAuth</b>, which leaves no token on disk. Add the server with this:
          </p>
          <div className="copy-row">
            <code className="mono-box live">{command}</code>
            <CopyButton text={command} />
          </div>
          <p className="landing-note">
            Then run <code>/mcp</code> in Claude Code, pick <b>tasks</b>, and choose <b>Authenticate</b>. Your browser
            opens here to sign in and allow it. Tag a card <code>#agent</code> and paste in the starter prompt.
            Teammates do the same once, and their agents reach the boards shared with them. Cursor, VS Code,
            Codex, ChatGPT, and Claude have their own steps on
            the <a href={`${BASE}/connect`}>Connect page</a>. You can read it all before you sign up.
          </p>
        </section>

        <Proof />

        <Pricing />

        <section className="landing-section landing-last">
          <p className="landing-lede">Look before you sign up.</p>
          <p className="landing-try">
            <a className="btn primary" href={DEMO}>Try the demo board</a>
            {signedIn ? <a className="btn" href={`${BASE}/`}>Open your board</a> : <a className="btn" href="#sign-in">Sign in</a>}
          </p>
        </section>
      </main>
      <Footer />
    </div>
  );
}

/** What sits where the sign-in form would, for someone who's already signed in (/tasks/pricing). */
export function SignedInCard({ email }: { email: string }) {
  return (
    <div className="login-card" id="sign-in">
      <h2 className="h">SIGNED_IN</h2>
      <p>You're signed in as <b>{email}</b>.</p>
      <a className="btn primary" href={`${BASE}/`}>Open your board</a>
    </div>
  );
}

// ---------- proof ----------

/** "12 changes" from the changelog counts baked into the build. Never typed in by hand. */
const changes = (n: number) => `${n.toLocaleString()} ${n === 1 ? "change" : "changes"}`;

/** How much has shipped, in the changelog's own numbers (`counts` in vite.config.ts). */
function shipped(): string {
  const { total, unreleased, latest } = __BUILD__.counts;
  if (!latest) return `${changes(total)} written up so far.`;
  const release = `v${latest.name}`;
  return unreleased > 0
    ? `${changes(unreleased)} written up since ${release}, ${total.toLocaleString()} in all.`
    : `${changes(latest.count)} in ${release}, ${total.toLocaleString()} in all.`;
}

/**
 * What a visitor can check without trusting us: the demo, the code, the changelog, the formats,
 * and who makes it. Every line here has to be true and checkable from the link beside it. No
 * user counts, star counts, logos, or quotes from anyone but the maker, because there are none
 * to show. The numbers come from CHANGELOG.md at build time.
 */
function Proof() {
  const out = { target: "_blank", rel: "noopener noreferrer" };
  return (
    <section className="landing-section" id="proof" aria-labelledby="proof-h">
      <h2 className="h" id="proof-h">CHECK_IT_YOURSELF</h2>
      <p className="landing-lede">Don't take our word for it.</p>
      <div className="proof">
        <dl className="proof-list">
          <div>
            <dt>Demo</dt>
            <dd>The demo is the real board, running in your browser tab with a scripted agent. No account, and nothing is saved.</dd>
            <dd className="proof-go"><span className="prompt" aria-hidden="true">$</span> <a href={DEMO}>Try the demo board</a></dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>The code is public: the Worker, the client, and every MCP tool your agent calls, cards, pages, worksheets, and search included.</dd>
            <dd className="proof-go"><a href={REPO} {...out}>Read the code</a></dd>
          </div>
          <div>
            <dt>Changelog</dt>
            <dd>Built in the open by coding agents working cards on a Tasks board. <b>{shipped()}</b></dd>
            <dd className="proof-go"><a href={`${REPO}/blob/main/CHANGELOG.md`} {...out}>Read the changelog</a></dd>
          </div>
          <div>
            <dt>Formats</dt>
            <dd>Pages are Markdown files and export as HTML, Word (.docx), and PDF; worksheets export as CSV. An encrypted board is standard JWE (RFC 7516): any JOSE library opens a backup with your passphrase, and without it, nobody does.</dd>
            <dd className="proof-go"><a href={`${REPO}#-end_to_end_encryption`} {...out}>See the format</a></dd>
          </div>
          <div>
            <dt>Protocol</dt>
            <dd>The agent side is MCP over Streamable HTTP with OAuth sign-in, nothing custom. It all runs on Cloudflare Workers.</dd>
            <dd className="proof-go"><a href={`${BASE}/connect`}>See the setup</a></dd>
          </div>
        </dl>
        <figure className="maker">
          <figcaption className="maker-who">
            <span>Maker</span>
            Tasks is made by one developer, <a href="https://askscottpierce.com" {...out}>Scott Pierce</a>. Here's why:
          </figcaption>
          <blockquote>
            “… I still get lost in progressing my projects forward. This Tasks app is my initial approach at
            getting back to basics so I can manage the projects without needing to swim through oceans of
            text to recall what's going on.”
          </blockquote>
          <p className="maker-by">Scott Pierce</p>
        </figure>
      </div>
    </section>
  );
}

// ---------- the pictures ----------

// One fixed moment, so the pictures read the same on every load: "4s ago" stays 4s ago.
const NOW = Date.parse("2026-10-01T15:04:05Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const card = (id: string, title: string, more: Partial<Card> = {}): Card => ({
  id, title, notes: "", laneId: "sample", due: null, createdAt: at(86_400_000), updatedAt: at(60_000), ...more,
});

const TODO: Card[] = [
  card("s1", "Write the 1.4 release notes", { tags: ["agent"] }),
  card("s2", "Flaky test in the checkout spec", { tags: ["agent"], notes: "Fails about one run in ten on CI.", assignee: "dana@example.com" }),
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
  card("s5", "Q4 pipeline review: fill the worksheet", { tags: ["agent"], assignee: "dana@example.com" }),
];

const DONE: Card[] = [
  card("s6", "Add the CSV export", { tags: ["agent"], notes: "STATUS: done — export is behind the orders menu, tests pass" }),
  card("s7", "Bump the Node version in CI"),
];

// The top bar's count, by the app's own rule: "need you" is the open questions.
const NEED_YOU = [...TODO, ...DOING].filter((c) => c.ask).length;

function SampleLane({ name, index, cards, done = false }: { name: string; index: number; cards: Card[]; done?: boolean }) {
  return (
    <section className="lane" style={{ ["--lane-color" as string]: `var(--lane-${index + 1})` }}>
      <header className="lane-head">
        <span className="lane-dot" />
        <span className="lane-name">{name}</span>
        <span className="lane-count">{cards.length}</span>
      </header>
      <div className="cards">
        {cards.map((c) => <CardFace key={c.id} card={c} isDone={done} />)}
      </div>
    </section>
  );
}

/** The top bar as the app draws it: the board switcher and the section nav (SectionNav.tsx), with `current` marked. */
function SampleBar({ board, current, right }: { board: string; current: "board" | "pages" | "sheets"; right?: ReactNode }) {
  return (
    <div className="topbar">
      <span className="wordmark">tasks<span>.</span></span>
      <span className="btn board-switch-btn"><span className="board-switch-name">{board}</span><span className="board-switch-caret">▾</span></span>
      <span className="section-nav">
        <span className="btn" aria-current={current === "board" ? "page" : undefined}><span className="label">Board</span></span>
        <span className="btn" aria-current={current === "pages" ? "page" : undefined}><span className="label">Pages</span><span className="section-caret">▾</span></span>
        <span className="btn" aria-current={current === "sheets" ? "page" : undefined}><span className="label">Worksheets</span><span className="section-caret">▾</span></span>
      </span>
      <span className="spacer" />
      {right}
    </div>
  );
}

/**
 * A small board with sample data: a question waiting on a card, a card assigned to a teammate,
 * the count of what needs you, and finished work in Done. It's `inert`, so nothing in it takes a
 * click or a tab stop; the demo board is the one to play with. Screen readers get one sentence
 * instead of a pile of dead buttons.
 */
function Shot() {
  return (
    <figure className="shot">
      <div className="shot-frame" role="img" aria-label="A sample board called Shop API with three lanes, under a top bar that offers Board, Pages, and Worksheets. A card in Doing carries an agent's question, Limit by IP or by account, with three options and one marked recommended. Two cards are assigned to a teammate, Dana. The top bar says one needs you. Done holds two finished cards.">
        <div className="shot-inner" inert aria-hidden="true">
          <SampleBar board="Shop API" current="board" right={<span className="btn asks-btn"><span className="asks-count">?{NEED_YOU}</span><span className="label">need{NEED_YOU === 1 ? "s" : ""} you</span></span>} />
          <div className="shot-body">
            <SampleLane name="To do" index={0} cards={TODO} />
            <SampleLane name="Doing" index={1} cards={DOING} />
            <SampleLane name="Done" index={2} cards={DONE} done />
          </div>
        </div>
      </div>
      <figcaption>
        Sample data, drawn with the app's own components. <a href={DEMO}>Try the demo board</a> to click around.
      </figcaption>
    </figure>
  );
}

// A page and a worksheet from the same sample board, drawn with the app's renderer and grid.
const SAMPLE_PAGE = `# Q4 plan

Ship the orders API by the end of October, then spend November on the pipeline.

## This month

- [x] Rate limit the login endpoint
- [ ] Move the orders table to D1
- [ ] Write the 1.4 release notes

## Pipeline

The numbers are in the **Pipeline** worksheet. Dana's agent fills it from the CRM export each Monday; \`query_sheet\` totals it for the Friday review.
`;

const SAMPLE_COLUMNS = [
  { name: "Account", type: "text" },
  { name: "Stage", type: "text" },
  { name: "Amount", type: "number" },
  { name: "Close", type: "date" },
] as const;

const SAMPLE_ROWS: [string, string, string, string][] = [
  ["Northwind", "Proposal", "24,000", "2026-10-30"],
  ["Contoso", "Negotiation", "61,500", "2026-11-14"],
  ["Fabrikam", "Qualified", "9,800", "2026-12-02"],
  ["Tailspin", "Proposal", "18,250", "2026-11-21"],
];

function OfficeShot() {
  return (
    <figure className="shot office-shot">
      <div className="office-shots">
        <div className="shot-frame" role="img" aria-label="A page called Q4 plan on the sample board, rendered as Markdown: a heading, a paragraph, a checklist with one item done, and a note that the numbers are in the Pipeline worksheet.">
          <div className="shot-inner" inert aria-hidden="true">
            <SampleBar board="Shop API" current="pages" />
            <div className="office-body">
              <div className="pages-head"><h3 className="pages-title">docs/q4-plan.md</h3><span className="pages-meta">changed by dana, 2 min ago</span></div>
              <div className="pages-body"><Markdown text={SAMPLE_PAGE} fixed="Sample page" /></div>
            </div>
          </div>
        </div>
        <div className="shot-frame" role="img" aria-label="A worksheet called Pipeline on the sample board: a grid with Account, Stage, Amount, and Close columns and four rows of deals.">
          <div className="shot-inner" inert aria-hidden="true">
            <SampleBar board="Shop API" current="sheets" />
            <div className="office-body">
              <div className="pages-head"><h3 className="pages-title">Pipeline</h3><span className="pages-meta">{SAMPLE_ROWS.length} rows · changed by dana's agent, 5 min ago</span></div>
              <div className="sheet-scroll">
                <table className="sheet-table">
                  <thead>
                    <tr>
                      <th className="sheet-rownum">#</th>
                      {SAMPLE_COLUMNS.map((c) => (
                        <th key={c.name} className={c.type === "number" ? "num" : ""}>
                          <div className="sheet-th"><span className="sheet-sort">{c.name}</span><span className="sheet-type">{c.type}</span></div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {SAMPLE_ROWS.map((r, i) => (
                      <tr key={r[0]}>
                        <td className="sheet-rownum">{i + 1}</td>
                        {r.map((v, j) => <td key={j} className={SAMPLE_COLUMNS[j].type === "number" ? "num" : ""}><span className={`sheet-cell-btn${SAMPLE_COLUMNS[j].type === "number" ? " num" : ""}`}>{v}</span></td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="office-query"><span className="prompt">$</span> SELECT Stage, SUM(Amount) FROM Pipeline GROUP BY Stage</div>
            </div>
          </div>
        </div>
      </div>
      <figcaption>
        The same sample board's page and worksheet, drawn with the app's own renderer and grid.
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
      <p className="landing-lede">The board, the pages, the worksheets, and MCP are free and never capped.</p>
      <p className="landing-note">
        Your own agents can read and change your board as much as they like on either plan. The one thing
        with a daily limit is the assistant built into the board, because that's the part that runs on our model bill.
        Pro raises that limit, adds boards, and lets you share them with other people.
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
              <li>One board. Unlimited cards, lanes, pages, worksheets, and MCP calls</li>
              <li>Questions, claims, search across it all, attachments, export, encryption</li>
              <li>Join boards other people share with you</li>
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
                <li>A board per project: up to <b>{loaded.pro.boards}</b> boards, each with its own cards, pages, and worksheets</li>
                <li>Team boards: invite up to <b>{loaded.pro.members}</b> people to a board by email, as viewers or writers. They join free, and their agents come with them</li>
                <li>An audit log of who was invited, who joined or left, and who deleted which card</li>
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
      {loaded?.pro && (
        <div className="plan-facts">
          <h3 className="h">HOW_SHARING_WORKS</h3>
          <dl>
            {sharingFacts(loaded.pro.members).map((f) => <div key={f.q}><dt>{f.q}</dt><dd>{f.a}</dd></div>)}
          </dl>
          <p className="landing-note">The same answers are in the <a href={`${BASE}/terms#team-boards`}>terms</a>.</p>
        </div>
      )}
    </section>
  );
}
