import { useEffect } from "react";
import { BASE } from "./base";
import { Footer } from "./Footer";
import { sharingFacts, usePlans } from "./sharing";
import { useTitle } from "./title";

// Privacy policy and terms at /tasks/privacy and /tasks/terms. Public (no sign-in),
// because Google and Microsoft link to them from their sign-in screens. Keep them
// in step with what the app actually stores; README → // PRIVACY_AND_TERMS.

const UPDATED = "October 4, 2026";
const CONTACT = "hey@askscottpierce.com";

export type LegalPage = "privacy" | "terms";

export function Legal({ page, onBack }: { page: LegalPage; onBack(): void }) {
  useTitle(page === "privacy" ? "Privacy" : "Terms");
  // A link to a section (/tasks/terms#team-boards) lands on it: the page is drawn after the browser looked for the anchor.
  useEffect(() => {
    const id = location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView();
  }, [page]);
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
          <li><b>Your board</b>: lanes, cards, notes, tags, and due dates, plus the last 30 changes so you can undo them. Questions an agent asks on a card, and your answers, are kept on the card. We also keep a search index of your card titles and notes, and the time an agent first connected to the board, so it can stop telling you none has.</li>
          <li><b>Files you attach</b> to cards, up to 250 MB per account. When you remove a file or delete its card, we delete the file once undo can no longer bring it back, usually within a day or two and at most a few weeks later.</li>
          <li><b>Your assistant chat</b>: up to the last 120 messages, and a daily count of how many you've sent.</li>
          <li><b>Sign-in records</b>: one-time sign-in codes (kept 10 minutes) and sessions (30 days). We store only scrambled versions (hashes) of these, not the codes themselves. To stop code guessing, we also count sign-in code tries by email address and by IP address, and clear those counts after a day.</li>
          <li><b>Connected agents</b>: access tokens you create, including the one made each time you press Copy the command in the quick start, and apps you allow to reach your board. Tokens are stored only as hashes, with a name, when each was made, and when it was last used. They stay until you revoke them on the Connect page, except a quick start token that was never used, which is removed when you copy the command again.</li>
          <li><b>Agent sessions and claims</b>. When an agent claims a card, or asks you a question on one and says which session is asking, we keep one record for that session: its id, and what the agent tells us about itself (what kind of agent it is, the machine's name, and the name of the folder it's working in), whether it's working or idle, when it started and when we last heard from it, and one line about its last action, which names the card, like <code>claimed "Fix the login bug"</code>. We also keep which session holds which card and since when. While a question that session asked on the card is open, we keep a copy of the question with that, so the board can say which session is waiting on you. The copy is removed when you answer or the question is taken back. This happens for any agent you connect, with nothing else installed. If you also install the Claude Code reporting hooks, the record adds the folder's path, whether the session is stopped at a prompt in its terminal, and a link back to the session if you set one (the optional <code>X-Tasks-Link</code> header), and the last-action line becomes a tool and file name, a short description of a shell command (never the command itself), or Claude's notification text. Never prompts, tool output, commands, or transcripts. Each session overwrites its own record. Records are deleted when the session ends or 24 hours after they last changed, and a claim ends when its card is done or deleted, or 15 minutes after its session was last heard from. An encrypted board keeps none.</li>
          <li><b>Shared boards</b>. If you invite someone to your board, we keep their email address, the role you gave them (viewer or writer), whether they've accepted, and when. The invite link is stored only as a hash, works once, and expires after 7 days. After you accept, we keep that hash with your membership so that opening the email again can tell you you're already on the board. It's deleted with the membership. If you're invited, the person who invited you sees your email address and role, you see theirs, and the invite lets that address sign in. We count the invite emails each owner sends per day, tries at opening invite links by account and IP address (cleared after a day), and how many cards each member deletes on a board per day. We also keep a log for the board's owner of invites sent, accepted, declined, revoked, and expired, role changes, removals, people leaving, and sharing pausing or resuming with the owner's plan: who did it, to whom, and when. When sharing pauses or resumes because an admin of Tasks gave or took back the owner's Pro plan, that line shows the admin's email address to the board's owner, marked as a site admin. When it's because of a payment, it says <code>system</code>. That log can't be edited, the owner can download it, and it's kept as long as the owner's account is. Removing someone, declining, or leaving deletes the membership itself right away.</li>
          <li><b>Deleted cards on a shared board</b>. Once a board has been shared, deleting a card from it adds a line to that same log: who deleted it, when, the card's title, and the lane it was in. The same goes for a card that undo brings back. The card's notes, tags, and files aren't copied into the log, but its title is, and it stays there after the card itself is gone, for as long as the owner's account is. Only the board's owner can read the log. Everyone with the board open at that moment is also shown who deleted the card and its title. A board that was never shared keeps no such log, and an encrypted board can't be shared, so no encrypted title ever reaches it.</li>
          <li><b>Who changed a card</b>. Each card records the email address of whoever last changed it, and whether the assistant or an agent did it for them, so a shared board can show it. When a member writes a card's title or notes, or changes its tags, the card also keeps that member's email address and when, until the board's owner marks the words as their own. Each file attached on a shared board keeps the email address of whoever uploaded it and whether they were the owner or a member, for as long as the file is on the card. Everyone on the board can see all of this, and so can the agents the owner connects, so a member's words and files aren't taken for the owner's.</li>
          <li><b>Subscription status</b>, if you upgrade: your Stripe customer ID and whether the subscription is active. We never see or store your card details.</li>
          <li><b>Your account record</b>: your email, when you first and last signed in, whether you're an admin of Tasks, and whether an admin gave you the Pro plan, with who changed that and when. If you've shared your board, the admin's email address also appears in your board's log when that changes what your members can do (see Shared boards above). Admins can see this list of accounts and each account's plan. They can't see anyone's board, files, or chat, or who a board is shared with.</li>
          <li><b>Your theme</b>, and a few display preferences kept in your own browser.</li>
        </ul>
      </section>

      <section>
        <h3 className="subhead">End-to-end encryption</h3>
        <p>If you turn on encryption with a passphrase (user menu → Encrypt with a passphrase), your browser encrypts your lane names, cards, notes, tags, due dates, attached files and their names, and assistant messages before they're sent. We store only the encrypted form and can't read it, and neither can Cloudflare, the cloud assistant, or connected agents. Your passphrase never leaves your browser, so we can't recover a board if you forget it.</p>
        <p>What stays readable to us on an encrypted board: your email, how many lanes, cards, and files you have and their sizes, when things were created or changed and whose account changed each card last, your theme, and the sign-in, subscription, and usage records above. If you shared the board before you encrypted it, the record of which former member wrote on a card, attached a file, or changed a card last (their email and when) stays readable too, so those cards are still marked if you turn encryption off. Turning encryption on erases the plain-text board, undo history, chat, search index, and agent session records from the live database, but copies of what you stored <i>before</i> turning it on can remain in Cloudflare's storage backups for up to 30 days.</p>
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
        <p>Email <a href={`mailto:${CONTACT}`}>{CONTACT}</a> from the address you sign in with, and we'll delete your account, board, and chat history, along with your board's members, its invites, and its log. Cards you added to someone else's board stay there, and so do that board's log entries that name you: they belong to its owner. Cancel any Pro subscription first under Manage subscription. Stripe keeps its own payment records as the law requires.</p>
      </section>

      <section>
        <h3 className="subhead">Changes</h3>
        <p>If this policy changes in a way that matters, we'll update this page and the date below.</p>
      </section>
    </>
  );
}

function Terms() {
  // How many people a board holds comes from the server's own setting, never typed in here.
  const plans = usePlans();
  const facts = sharingFacts(plans?.pro?.members ?? null);
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
          <li>Tasks is free to use. Free accounts get a daily number of assistant messages. Your own board and the agents you connect to it aren't limited. On a board someone shared with you, how fast you can send changes and how big you can make it are capped.</li>
          <li>Tasks Pro is a subscription, billed through Stripe. It raises the daily assistant limit and adds team boards: you can invite people to your board by email, each as a viewer or a writer. You can cancel any time under Manage subscription, and Pro lasts until the end of the period you've paid for.</li>
          <li>Limits, features, and prices may change. We'll give notice before a price change affects an active subscription.</li>
        </ul>
      </section>

      <section id="team-boards">
        <h3 className="subhead">Team boards</h3>
        <p>What you're buying when you share a board, and what you're agreeing to when you join one.</p>
        <ul>
          {facts.map((f) => <li key={f.q}><b>{f.q}</b> {f.a}</li>)}
          <li><b>Who's responsible for who's on it?</b> The owner. You choose who to invite and what role they get, and you can change a role or remove someone at any time. It takes effect right away, in any tab they have open. A member can leave whenever they like.</li>
        </ul>
      </section>

      <section>
        <h3 className="subhead">Your content</h3>
        <p>What you put on your board is yours. You let us store and process it only to run Tasks for you, including sending it to the AI assistant when you use it. What you add to a board someone shared with you belongs to that board's owner, and stays on it if you leave.</p>
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
        <p>The assistant can misunderstand you or make mistakes. Check what it changes. On your own board every change can be undone. On a board someone shared with you, undo is the owner's.</p>
      </section>

      <section>
        <h3 className="subhead">No warranty</h3>
        <p>Tasks is provided as is, without warranties of any kind. As far as the law allows, we aren't liable for lost data, missed deadlines, or indirect damages. Our total liability is limited to what you paid us in the last 12 months.</p>
      </section>
    </>
  );
}
