import { BASE } from "./base";
import { Footer } from "./Footer";

// Privacy policy and terms at /tasks/privacy and /tasks/terms. Public (no sign-in),
// because Google and Microsoft link to them from their sign-in screens. Keep them
// in step with what the app actually stores; README → // PRIVACY_AND_TERMS.

const UPDATED = "September 29, 2026";
const CONTACT = "hey@askscottpierce.com";

export type LegalPage = "privacy" | "terms";

export function Legal({ page, onBack }: { page: LegalPage; onBack(): void }) {
  return (
    <div className="connect">
      <header className="topbar">
        <h1 className="wordmark">tasks<span>.</span></h1>
        <span className="spacer" />
        <a className="btn" href={`${BASE}/`} onClick={(e) => { e.preventDefault(); onBack(); }}>← Back to Tasks</a>
      </header>
      <main className="connect-body legal">
        {page === "privacy" ? <Privacy /> : <Terms />}
        <p className="muted">
          Last updated {UPDATED}. Questions: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
          {" "}See also the <a href={`${BASE}/${page === "privacy" ? "terms" : "privacy"}`}>{page === "privacy" ? "terms of service" : "privacy policy"}</a>.
        </p>
      </main>
      <Footer />
    </div>
  );
}

function Privacy() {
  return (
    <>
      <section className="connect-intro">
        <h2 className="h">PRIVACY_POLICY</h2>
        <p className="lede">What Tasks keeps, and why.</p>
        <p>Tasks is a task board with an AI assistant, run by Scott Pierce at askscottpierce.com. We keep only what the app needs to work. We don't sell your data, show ads, or use tracking cookies.</p>
      </section>

      <section>
        <h3 className="subhead">What we store</h3>
        <ul>
          <li><b>Your email address</b>, to sign you in and to tell your board apart from everyone else's. If you sign in with Google or Microsoft, we receive your verified email from them and keep only that.</li>
          <li><b>Your board</b>: lanes, cards, notes, and due dates, plus the last 30 changes so you can undo them, and a search index of your card titles and notes.</li>
          <li><b>Files you attach</b> to cards, up to 250 MB per account. When you remove a file or delete its card, we delete the file once undo can no longer bring it back, usually within a day or two and at most a few weeks later.</li>
          <li><b>Your assistant chat</b>: up to the last 120 messages, and a daily count of how many you've sent.</li>
          <li><b>Sign-in records</b>: one-time sign-in codes (kept 10 minutes) and sessions (30 days). We store only scrambled versions (hashes) of these, not the codes themselves.</li>
          <li><b>Connected agents</b>: access tokens you create and apps you allow to reach your board. Tokens are stored only as hashes.</li>
          <li><b>Claude Code sessions</b>, only if you install the reporting hook: for each running session, its id, the folder it runs in, the machine's name, whether it's working, idle, or waiting on you, and one line about its last action (a tool and file name, or Claude's notification text). Never prompts, tool output, commands, or transcripts. Each session overwrites its own record, and records are deleted when the session ends or after 24 hours. An encrypted board keeps none.</li>
          <li><b>Subscription status</b>, if you upgrade: your Stripe customer ID and whether the subscription is active. We never see or store your card details.</li>
          <li><b>Your theme</b>, and a few display preferences kept in your own browser.</li>
        </ul>
      </section>

      <section>
        <h3 className="subhead">End-to-end encryption</h3>
        <p>If you turn on encryption with a passphrase (user menu → Encrypt with a passphrase), your browser encrypts your lane names, cards, notes, due dates, attached files and their names, and assistant messages before they're sent. We store only the encrypted form and can't read it, and neither can Cloudflare, the cloud assistant, or connected agents. Your passphrase never leaves your browser, so we can't recover a board if you forget it.</p>
        <p>What stays readable to us on an encrypted board: your email, how many lanes, cards, and files you have and their sizes, when things were created or changed, your theme, and the sign-in, subscription, and usage records above. Turning encryption on erases the plain-text board, undo history, chat, and search index from the live database, but copies of what you stored <i>before</i> turning it on can remain in Cloudflare's storage backups for up to 30 days.</p>
      </section>

      <section>
        <h3 className="subhead">Who handles it for us</h3>
        <ul>
          <li><b>Cloudflare</b> hosts the app and stores your data, including attached files. On a board without encryption, when you use the cloud assistant, your message, recent chat, and board are processed by Cloudflare Workers AI to write a reply and update the board. Card titles and notes are also processed by Workers AI to power search by meaning. Cloudflare also sends sign-in emails and runs Turnstile, which checks that sign-ins come from people rather than bots.</li>
          <li><b>Stripe</b> processes payments for Pro.</li>
          <li><b>Google or Microsoft</b>, only if you choose to sign in with them.</li>
          <li><b>Agents you connect</b> (such as Claude, ChatGPT, or Glean) can read and change your board once you allow them. Their own privacy policies cover what they do with it. You can disconnect them at any time on the Connect page.</li>
        </ul>
      </section>

      <section>
        <h3 className="subhead">Cookies</h3>
        <p>One cookie keeps you signed in. Sign-in with Google or Microsoft uses a short-lived cookie for about 10 minutes to complete the redirect. That's all.</p>
      </section>

      <section>
        <h3 className="subhead">Deleting your data</h3>
        <p>Email <a href={`mailto:${CONTACT}`}>{CONTACT}</a> from the address you sign in with, and we'll delete your account, board, and chat history. Cancel any Pro subscription first under Manage subscription. Stripe keeps its own payment records as the law requires.</p>
      </section>

      <section>
        <h3 className="subhead">Changes</h3>
        <p>If this policy changes in a way that matters, we'll update this page and the date below.</p>
      </section>
    </>
  );
}

function Terms() {
  return (
    <>
      <section className="connect-intro">
        <h2 className="h">TERMS_OF_SERVICE</h2>
        <p className="lede">The short version: be reasonable, and so will we.</p>
        <p>By using Tasks you agree to these terms. Tasks is run by Scott Pierce at askscottpierce.com.</p>
      </section>

      <section>
        <h3 className="subhead">The service</h3>
        <ul>
          <li>Tasks is free to use. Free accounts get a daily number of assistant messages. The board and connected agents aren't limited.</li>
          <li>Tasks Pro is a monthly subscription, billed through Stripe, that raises the daily assistant limit. You can cancel any time under Manage subscription, and Pro lasts until the end of the period you've paid for.</li>
          <li>Limits, features, and prices may change. We'll give notice before a price change affects an active subscription.</li>
        </ul>
      </section>

      <section>
        <h3 className="subhead">Your content</h3>
        <p>What you put on your board is yours. You let us store and process it only to run Tasks for you, including sending it to the AI assistant when you use it.</p>
      </section>

      <section>
        <h3 className="subhead">Fair use</h3>
        <ul>
          <li>Don't use Tasks to break the law, to harm others, or to store content you don't have the right to store.</li>
          <li>Don't try to get around the usage limits, for example by creating many accounts, and don't overload or attack the service.</li>
          <li>We may suspend accounts that do these things.</li>
        </ul>
      </section>

      <section>
        <h3 className="subhead">The AI assistant</h3>
        <p>The assistant can misunderstand you or make mistakes. Check what it changes. Every change can be undone.</p>
      </section>

      <section>
        <h3 className="subhead">No warranty</h3>
        <p>Tasks is provided as is, without warranties of any kind. As far as the law allows, we aren't liable for lost data, missed deadlines, or indirect damages. Our total liability is limited to what you paid us in the last 12 months.</p>
      </section>
    </>
  );
}
