# Launch checklist

What only you can do, in order. Nothing in this kit deploys, posts, or creates an account.
A line that starts with **Q:** is something I couldn't find out and didn't want to guess at.

## // BEFORE_LAUNCH_DAY

Do these top to bottom. Each later step assumes the earlier ones.

### 1. Ship the branch

- [ ] Merge this work to `main` and run the checks: `npm run typecheck`, `npm run build`,
      `npm run check:markdown`, `npm run check:sort`, `npm run check:events`, `npm run check:nudge`,
      `npm run check:setup`, `npm run check:launch`.
- [ ] `npm run deploy`, and `npm run db:migrate:remote` if `migrations/` changed since the last deploy.
- [ ] Open https://askscottpierce.com/tasks/ and compare the footer with `git rev-parse --short HEAD`.
      It should read `$ v0.1.0 · <that commit>` with no `+` after it. A `+` means the build had
      uncommitted changes.
- [ ] **Q:** `CHANGELOG.md` has a long `[Unreleased]` section on top of 0.1.0. Do you want to cut
      a release (0.2.0?) before launch so the footer and `// WHATS_NEW` show a clean version?
      The steps are in the README under `// VERSION_AND_CHANGELOG`.

### 2. Make sure a stranger can get in

- [ ] `ALLOWED_EMAILS` is `""` in `wrangler.jsonc` on this branch, which means anyone can sign
      up. Confirm that's what is deployed: Cloudflare dashboard → Workers → `todo-agent` →
      Settings → Variables. A value set in the dashboard is replaced by the next `wrangler deploy`,
      so the file is what counts, but look anyway.
- [ ] In a private window, sign up with an email address that has never touched Tasks. Time how
      long the code takes to arrive and check it didn't land in spam. Do it once with a Gmail
      address and once with something else.
- [ ] Sign in with Google from that private window too.
- [ ] **Q:** Microsoft sign-in only appears when both of its secrets are set. Is it meant to be on
      for launch?
- [ ] From that new account: create a card, tag it `#agent`, open `/tasks/connect`, run the
      `claude mcp add` command on a machine that has never connected, and have the agent ask a
      question. Answer it from your phone. That's the whole pitch, so it has to work cold.
- [ ] Open https://askscottpierce.com/tasks/demo in a private window and on your phone. Answer
      the question and watch the scripted agent finish the card and ask the next one.

### 3. Decide on Pro

- [ ] `STRIPE_PRICE_ID` is empty on this branch, so billing is off and the landing page says
      "Pro isn't on sale yet." Pick one:
  - **Pro is on sale at launch.** Follow `// BILLING` in the README (price id, portal
        configuration, webhook, two secrets), deploy, and confirm the landing page shows the
        price. Buy it once with a real card and cancel from the account menu. Then fill in the
        blanks in `product-hunt.md` under `// PRICING` and choose "Paid (with a free trial or plan)"
        on the form.
  - **Pro is not on sale at launch.** Leave it. Choose "Free" on the form and use the free
        pricing line. This is the smaller risk on launch day.
- [ ] **Q:** which one? I'd launch free and turn Pro on later, but it's your call and your bill.

### 4. Check what a shared link looks like

- [ ] Paste `https://askscottpierce.com/tasks/` into a Slack DM to yourself, an iMessage, and a
      draft post on X and on LinkedIn. Each should show the title, the description, and the board
      picture (`og.png`). LinkedIn's Post Inspector (linkedin.com/post-inspector) forces a refresh.
- [ ] If the landing changed tonight, make sure `og.png` still matches it. `npm run og` redraws it.
      Previews are cached, so a changed image needs a new file name (README,
      `// LINK_PREVIEWS_AND_TITLES`).

### 5. Shoot the gallery from the live site

- [ ] `npm run shots -- https://askscottpierce.com`. The images in `docs/launch/gallery/` right
      now came from a dev server, so their footer shows a dev build.
- [ ] Open all eight PNGs and look at them. If the run fails, it says which thing on the page it
      was waiting for.
- [ ] If the landing shot (`07`) fails on the human check, Turnstile didn't pass a headless
      browser. Skip it: `npm run shots -- https://askscottpierce.com --only 01,02,03,04,05,06,thumb`.
- [ ] Commit the new images.

### 6. License

- [ ] The repo is public and has no `LICENSE` file. Legally that's "all rights reserved", and
      someone will ask. Pick one:
  - Add a license and say its name in the "Is it open source?" answer.
  - Leave it and keep the answer as written: "source is public", no license claimed.
- [ ] **Q:** which one? I didn't add a license because that's a decision about your rights.
- [ ] The README is the first thing a visitor to the repo reads. It's written for you, and it
      includes the "Accepted risk: a shared origin" section. That's honest and I'd leave it, but
      read it once as a stranger before you send people there.

### 7. Record the video (optional)

- [ ] `video.md` is a shot list for a 60 to 90 second screen recording. Product Hunt only takes a
      YouTube link, and the video can't be private. Unlisted works.
- [ ] **Q:** do you want a video at all? The gallery carries the launch without one.

### 8. Fill in the form and schedule it

- [ ] Search Product Hunt for "Tasks" and decide on the name (`product-hunt.md`, `// NAME`).
- [ ] Start the submission at https://www.producthunt.com/posts/new and paste from
      `product-hunt.md`: name, tagline, description, tags, links, pricing.
- [ ] Upload `thumbnail-240.png`, then the gallery in number order. `01` goes first because the
      first image is what shows when the launch is shared.
- [ ] Paste the first comment into the form. It asks for one at submission, so it's there the
      second the launch goes live.
- [ ] Schedule it. Product Hunt lets you schedule up to a month ahead.
- [ ] **Q:** which day? Product Hunt's guide doesn't name a best day. Midweek has more voters and
      more competition; a weekend has fewer of both. Pick a day you can be at the keyboard for
      most of it, since answering comments matters more than the day.
- [ ] **Q:** do you have a Product Hunt account already, and is it more than a few days old? New
      accounts are sometimes held back. I couldn't check.

### 9. Who to tell, and when

Write these the night before and send them after the launch is live, not before. Ask people to
try the demo and say what they think. Don't ask for upvotes; Product Hunt's rules are against it.

- [ ] X: the post in `product-hunt.md`, with `01-board-question.png`.
- [ ] LinkedIn: the post in `product-hunt.md`.
- [ ] Hacker News: the Show HN in `product-hunt.md`. **Q:** same day or a different one? Two
      comment threads at once is a lot for one person. I'd do HN a day or two later.
- [ ] **Q:** anyone you'd message directly? People who use Claude Code or Cursor every day are
      the ones whose feedback is worth having. I don't know who they are for you.
- [ ] **Q:** is there a mailing list or a blog on askscottpierce.com or ddrscott.site that should
      carry a post?
- [ ] The MCP-specific places (r/ClaudeAI, r/mcp, the MCP and Claude Code Discords) each have
      their own rules about self-promotion. **Q:** are you a member of any of them already? Read
      the rules before posting, and don't post in ones you've never been in.

## // LAUNCH_DAY

### When

- [ ] **12:01 AM Pacific.** Product Hunt's guide gives the reason: the homepage runs on a 24-hour
      cycle on Pacific time, so 12:01 AM gives the launch the full day. That's 2:01 AM Central
      and 3:01 AM Eastern. If you scheduled it, you don't have to be awake for that minute.
- [ ] Be at the keyboard by the time the West Coast is up, around 8 AM Pacific, and plan to stay
      near it for the day.

### First hour you're up

- [ ] Open the launch page. Check the thumbnail, the gallery order, and that every link goes
      where it should.
- [ ] Confirm the first comment is there. If the form didn't take it, post it now.
- [ ] Sign up once more with a fresh email, on your phone, on cellular. If that's broken, nothing
      else matters.
- [ ] Send the posts from step 9.

### All day

- [ ] Answer every comment, including the short ones and the critical ones. The ready answers in
      `product-hunt.md` are a starting point. Add what the person actually asked.
- [ ] When someone reports a bug, say thanks, say whether you can reproduce it, and put it on your
      own board. Don't promise a date.
- [ ] Don't argue about other products. Say what Tasks does and what it doesn't.

### What to watch

Keep a terminal open on each.

- [ ] **Errors:** `npx wrangler tail todo-agent --status error`. Observability is on in
      `wrangler.jsonc`, so the dashboard's Logs tab has the same thing with history.
- [ ] **Sign-in email.** Every sign-up by email sends one code from `hey@askscottpierce.com`
      through Cloudflare Email Sending. **Q:** what's the daily sending limit on your account?
      I don't know it, and it's the first thing a traffic spike would hit. Look it up in the
      dashboard under Email before launch day. If codes stop arriving, Google sign-in still
      works, and that's what to tell people.
- [ ] **Workers AI.** The assistant (GLM) and search embeddings both use it. Each account is
      capped at 30 assistant messages a day (`FREE_DAILY_CHATS`), and plain commands run in the
      browser for free, but a few hundred new accounts trying the assistant adds up.
      **Q:** is the account on Workers Paid? On the free plan Workers AI stops at its daily
      allocation (10,000 Neurons a day, last I knew; check the current number). If it runs out,
      the board, MCP, questions, and Sessions all keep working. Only the assistant and semantic
      search stop. The lever is `FREE_DAILY_CHATS`.
- [ ] **Sign-in limits** (README, "Code guessing"). A code allows 5 tries. An email gets 10
      guesses an hour and 20 a day. An IP gets 30 guesses an hour. Someone behind a shared office
      or conference network could hit the IP limit; the answer is to wait an hour or use Google.
- [ ] **Turnstile.** If people say the sign-in button is stuck on "Checking you're human…", look
      at the Turnstile analytics in the dashboard. Google sign-in doesn't use it.
- [ ] **Durable Objects, D1, and R2** usage, in the dashboard, once in the morning and once at
      night. Attachments are capped at 250 MB per account.
- [ ] **Stripe**, if Pro is on sale: the webhook's delivery log.

### If something breaks

- [ ] A bad deploy: `npx wrangler rollback` puts the previous version back.
- [ ] Say so in a comment on the launch, plainly, and say again when it's fixed.

## // AFTER

- [ ] Day 2: reply to anything that came in overnight. Thank people by name.
- [ ] Go through every comment and DM and put each real problem on the board as a card. Tag the
      ones an agent can take.
- [ ] Write down what people expected that wasn't there. The likely ones: sessions for agents
      other than Claude Code, sharing a board with a teammate, and agents on an encrypted board.
- [ ] Post one follow-up when the first round of fixes ships: what people found and what changed.
      Add those lines to `CHANGELOG.md` as you go.
- [ ] If you held Hacker News back, post the Show HN now, with what you learned folded in.
- [ ] A week out: look at how many accounts connected an agent (`agentSeenAt` is the signal) next
      to how many signed up. That gap is the number to work on. **Q:** is there anything that
      counts this today? I didn't find a report for it, and Durable Object state is per user.
- [ ] Update the copy in `docs/launch/` if you'll reuse it, and re-run `npm run shots`.
