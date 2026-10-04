# Tasks

Live at **https://askscottpierce.com/tasks**. Tasks is a kanban-style task board with an assistant in the sidebar. Tell it "finished the
login test, add release notes for Friday" and the cards move while you watch. It runs entirely on
Cloudflare, and you sign in with an emailed code.

The point of the project is to show a simple task manager run by AI agents, where a small
model in the browser does the everyday work and a big LLM is only the backup. Needle 3 runs
right in the tab through [needle-rs](https://github.com/ddrscott/needle-rs) and handles plain
commands for free, with no API call. Anything it isn't sure about goes to GLM on Workers AI.

A board can also be end-to-end encrypted with a passphrase (`// END_TO_END_ENCRYPTION`). Then
the server holds only ciphertext and the in-browser model is the whole assistant.

## // STACK

| Piece | Cloudflare product |
|---|---|
| App + API | Workers, with static assets built by Vite + React |
| Board, chat history, undo stack | Agents SDK: one Durable Object (`TodoAgent`) per user, SQLite-backed |
| Assistant | Two paths: Needle 3 (a 121M tool-calling model) running in the browser tab through [needle-rs](https://github.com/ddrscott/needle-rs), free, for plain one-step commands; Workers AI `@cf/zai-org/glm-4.7-flash` (about $0.06 in / $0.40 out per M tokens) for everything else |
| Login codes + sessions | D1 (`todo-agent-auth`), plus optional Google and Microsoft sign-in (OpenID Connect) |
| Login email | Email Sending (`send_email` binding) from `hey@askscottpierce.com` |
| Bot protection | Turnstile on the email sign-in form, checked with Siteverify before any email goes out |
| Attachments | R2 (`ATTACHMENTS`), keys `<user id>/<attachment id>`; metadata on the card |
| Paid plan | Stripe Checkout and Customer Portal, webhook into D1 (`subscriptions`) |
| End-to-end encryption | Browser WebCrypto through [`jose`](https://github.com/panva/jose): JWE with PBES2-HS512+A256KW for the key, A256GCM for every field and file. The server only stores and checks shapes |
| Claude Code sessions | A `Presence` Durable Object per user (`src/presence.ts`): one row per session, plus card claims, fed by Claude Code hooks and by `claim_card` |
| Outside agents | MCP server (`agents/mcp/server`, stateless Streamable HTTP) behind `@cloudflare/workers-oauth-provider` (grants in KV `OAUTH_KV`), plus personal access tokens in D1 |

```
askscottpierce.com/tasks/assets/*  ──▶ static assets (no Worker hop)
askscottpierce.com/tasks/<page>    ──▶ Worker ──▶ the app's HTML for a page in src/routes.ts, a 404 for anything else
askscottpierce.com/tasks/api/*     ──▶ Worker ──▶ D1 (codes, sessions), EMAIL.send
askscottpierce.com/tasks/agent     ──▶ Worker ──session──▶ your TodoAgent (Durable Object)
                                          board state ⇄ UI · chat ─▶ Workers AI + board tools
askscottpierce.com/tasks/api/presence ◀── Claude Code hooks ──token──▶ your Presence (Durable Object)
askscottpierce.com/tasks/presence  ──▶ Worker ──session──▶ your Presence ─▶ the // SESSIONS list, live
askscottpierce.com/tasks/mcp       ──▶ OAuth provider ──token──▶ your TodoAgent, over RPC ─▶ board tools
askscottpierce.com/tasks/oauth/*   ──▶ OAuth provider (register, token) · consent screen (authorize)
askscottpierce.com/.well-known/oauth-{authorization-server, protected-resource/tasks/*} ──▶ OAuth discovery
```

The rest of askscottpierce.com is untouched. Two Worker routes (`/tasks`, `/tasks/*`)
run ahead of whatever serves the zone.

## // HOW_IT_WORKS

- **One board per user.** The client connects to `/tasks/agent`, and the Worker
  picks the Durable Object from the session cookie. No URL names a board, so there's
  no id to guess. The cookie is scoped to `Path=/tasks`.
- **One code path for every change.** Drag and drop, buttons, the assistant's
  tools, and MCP calls all end in the pure functions in `src/shared.ts`. The board
  tools are defined once in `src/tools.ts` for both the assistant and MCP, with their
  descriptions in `src/tool-docs.ts`. The agent
  rejects state pushed directly from clients.
- **Signed out.** `/tasks/` is the landing page (`src/client/Landing.tsx`), with the sign-in
  form (`src/client/Login.tsx`) in it. Above the fold at 1280x800: the headline, the form, a
  "Try the demo board" link to `/tasks/demo`, and a picture of the product. On a phone the
  order is headline, pitch, demo button, a slice of the picture (the top bar and the Doing
  lane, no Sessions list), then the form, so the first screen shows the product and the form
  is one short scroll or the Sign in link away. The form's email field takes focus on load
  only on a wide screen, because focusing it scrolls to it. The picture is not
  an image. It's `CardFace`, `AskBlock`, and the Sessions `SessionRow` fed sample data and marked
  `inert`, so it follows the theme and changes when the real components do. Keep it showing a
  question with a `REC` option, a claimed card, and a needs-input session. Its top bar counts
  them by the app's own rules (`blockedSessions`), so "need you" and Sessions read what the real
  bar would. Below the fold:
  `// WHATS_DIFFERENT` (which says the encryption trade-off plainly: an encrypted board is
  closed to outside agents), the `claude mcp add` command (`claudeMcpAdd` in `Connect.tsx`, the
  same one the Connect page shows) with a link to the public Connect page,
  `// CHECK_IT_YOURSELF`, and `// PRICING` (see `// BILLING`). Arriving with `?next=` (an
  agent's OAuth consent) shows only the form.
- **Proof on the landing page.** `// CHECK_IT_YOURSELF` (`Proof` in `Landing.tsx`) lists only
  what a visitor can verify, each row with the link that proves it: the demo board, the public
  repo, the changelog, the encryption format, the protocol, and what Sessions stores. Beside it
  is who makes Tasks and why, in Scott's own words. The changelog numbers (how many changes since
  the newest release, and in all) are counted from `CHANGELOG.md` when the build starts
  (`counts` in `vite.config.ts`); never type one in. Nothing on the page claims users, stars,
  logos, or quotes we don't have, and a row goes away if it stops being true. The copy holds to
  the same rule: an agent in any MCP client holds in `wait_for_answer` and gets the answer
  within a few seconds, so the page says that and doesn't name the event feed.
- **Pricing has an address.** `/tasks/pricing` is the landing page scrolled to `// PRICING`,
  signed in or out. Signed in, a "signed in as" card with a link to the board stands where the
  form would (`SignedInCard`).
- **Not found.** An address under `/tasks/` that isn't a page gets `src/client/NotFound.tsx`,
  signed in or not, and the response is a real **404**. The pages are listed once, in
  `src/routes.ts` (`PAGES`): `connect`, `privacy`, `terms`, `demo`, `pricing`, plus `/tasks/`
  itself. The client uses the list to pick the page and the Worker uses it to pick the status,
  so add a new page there, with a row in `PAGE_META` beside it for its title and description
  (`// LINK_PREVIEWS_AND_TITLES`; a page without a row doesn't compile). To make that possible the Worker answers every
  `/tasks` address (`run_worker_first` in `wrangler.jsonc`) except `/tasks/assets/*` and
  `/tasks/needle/*`, which the asset layer serves by itself, and `not_found_handling` is
  `none`: a page gets the app's HTML, a file in `public/tasks/` gets the file, and everything
  else gets the app's HTML with a 404, marked `noindex`. A missing file under `/tasks/assets/` is a bare 404.
- **Who's signed in.** `GET /tasks/api/me` answers 200 either way: the user, or `null` when
  nobody is signed in. It isn't a 401, so a signed-out visit leaves the browser console clean.
  Everything that needs a session still answers 401 without one.
- **The assistant panel** opens the way you left it: the Assistant button saves `open` or
  `closed` in this browser (`localStorage["todo-chat"]`). With nothing saved, the first board to
  load decides (`receive` in `App.tsx`). A board with cards opens the panel, as it always has.
  A board with no cards keeps it closed and saves that, so a new account's first screen is
  `// START_HERE` and the lanes at full width, and the panel doesn't spring open on a later
  visit: it opens when you open it (the Assistant button, or `/`). Under 900px wide it's always
  closed to start, behind the Ask button.
- **First run.** A board with no cards shows `// START_HERE` above its lanes
  (`src/client/FirstRun.tsx`): four steps that end with Claude Code working a card. Sign in
  (done), **Add a sample agent card**, **Copy the command**, paste it in a terminal. The steps
  are `QuickStart` in `Connect.tsx`, and the Connect page shows them too (`// CONNECT_AN_AGENT`
  has the command).
  - The sample card (`SAMPLE` in `FirstRun.tsx`) is a real card tagged `#agent`. Its notes have
    the agent read the folder it was started in, find 2 or 3 small improvements, ask which one
    with `ask_ceo`, then write a plan for the answer into the card's notes as a `- [ ]`
    checklist and move the card to Done. So the visitor sees a question land on the card,
    answers it in one tap, and watches the card finish. Adding it is one change, so one undo
    takes it back out.
  - **It has to finish on what the command allows.** The copied command pre-approves the
    board's tools and nothing else, and the visitor is looking at the browser, not the
    terminal. So the card asks for no file write and no command that changes anything: only MCP
    calls, listing the folder, and reading files in it, which Claude Code doesn't ask about.
    (2.1.289 has no Glob tool. It lists with a read-only `ls`, which it runs without asking.
    A card that said "no shell, not even ls" left the agent guessing at file names, and it
    asked on the card how to go on.) An earlier sample had the agent make the
    change, and it stopped at a Write approval nobody saw. In an empty or non-code folder the
    card has it offer first steps instead. Checked with real `claude -p` runs (2.1.289,
    `--allowedTools mcp__tasks`, no user settings) in an empty folder, a folder of two recipe
    text files, and a small Python project: question on the card within 30 seconds, one tap,
    Done 11 to 13 seconds later, no refused tool call. A `-p` run refuses what an interactive
    session would stop and ask about, so no refusals there means no prompts here.
  - The block stays up while that sample card is open and no agent has connected, so step 3 is
    still there after step 2 (`quickStartOpen`). It goes away when an agent connects, when the
    sample is deleted or done, or when the board has cards and none is the sample. An encrypted
    board never shows it.
  - **It folds once the command is copied.** With the sample on the board and the command on the
    clipboard, steps 1 to 3 are done and the rest happens in a terminal, then on the card. So the
    block folds to one line: "Copied. Paste it in a terminal, and pick Yes if Claude Code asks to
    trust the folder (Enter alone exits). Your agent's question will show up on the sample
    card.", with a **Show the steps** button that opens it again (and **Hide the
    steps** to fold it back). That keeps the lanes and the sample card in view at 1280x800 and on
    a phone, where the open block takes up to 55% of the screen and scrolls inside itself. The
    steps stay mounted while folded, since they hold the command and its token is shown once. A
    command the browser wouldn't put on the clipboard doesn't fold the block: it has to be copied
    from there by hand. A reload brings the open block back, without the command.
  - Its last line says how to tag your own cards: `#agent` at the end of the title, or the Tags field.
- **No agent connected yet.** From the first card on, a board no agent has ever reached says
  so (`src/client/AgentNudge.tsx`): one line above the lanes (not while `// START_HERE` is up,
  so the board says it once; with no `#agent` card yet, the line says how to tag one), a `no agent connected` chip on
  each open `#agent` or `#gauntlet` card, and the same in plain words in that card's editor,
  each linking to `/tasks/connect`. The X hides the line for that browser tab's session; the
  chips stay. The board remembers the first MCP request that got through (`agentSeenAt`, set
  by `noteAgentSeen` in `src/agent.ts`), and when it lands every open tab drops all three
  without a reload and says "An agent just connected". It's a setting like the theme: no undo
  step, no event on the feed, no card flashes, and undo, redo, and a board reset keep it
  (`keepSettings` in `src/shared.ts`). The handshake counts, so adding the server in a client
  is enough. Session hooks and the event feed don't count, since neither can read or change a
  card. A question or an answer on a card counts too, which covers boards that had agents
  before the timestamp existed. An encrypted board never shows any of it and records nothing.
  `npm run check:nudge` covers the rules.
- **Demo board.** `/tasks/demo` is the real board UI for someone who hasn't signed up
  (`src/client/Demo.tsx`). It renders before the sign-in check and never opens the agent or
  presence sockets: the board is React state in the tab, changed through the same functions in
  `src/shared.ts`, with undo and redo kept in memory. The seed board, its three sessions, and the
  script one pretend agent follows are in `src/client/demoData.ts`. Answer its question and its
  session goes back to working in the same moment; it then updates the card's `STATUS:` line,
  ticks the checklist, moves the card to Done, picks up the next card, and asks again. When the
  script runs out, the strip under the top bar says "That's the loop" and offers Start over.
  - **Undo there is the visitor's.** Unlike a real board, where an agent's MCP call is an undo
    step, the scripted agent's steps never go on the stack. Each remembered board is saved with
    how far the agent had got on it (`World` in `Demo.tsx`), and each agent step is also made on
    every remembered board where the agent was at the same point. So undoing "Add card" leaves
    what the agent did since, and undoing an answer puts the question back and the agent back
    to waiting, along with anything it did because of that answer.
  - **The lead session can't disagree with its card.** It says needs input exactly while the
    card it's on has a question open; nothing else is stored.
  - **It follows what the visitor does to its card.** Finish the card before answering and it
    takes its question back and moves on. Take `#needs-ceo` off and it goes with its own
    recommendation. Delete the card and it takes the next one; undo that and it's back on it.
    A card dialog that's open when the agent changes the card is redrawn from the new card,
    which drops anything typed in it and not saved.
  - **The other two sessions run on the clock** (`demoPresence`, redrawn every second). The
    working one in shop-web steps through a short loop of tool calls: its "seen" time counts up
    a few seconds, then starts over with a new last-action line, the way a session with hooks
    reports after each tool. The idle one in infra was last heard from a minute before the demo
    opened and only gets older, so four minutes in it's marked stale like any quiet session.
  - **On a phone** it opens on the lane that holds the open question, not the first lane, and
    the Theme button stays in the top bar, since there's no account menu to put it in. Start
    over is in the strip the whole time there too, at the end of its first row.

  A strip under the top bar says it's a demo and nothing is saved, with links to sign up and to
  Connect; a reload or Start over resets it. The seed has `agentSeenAt` set, so "No agent
  connected yet" never shows there. The only request the page makes is the `GET /tasks/api/me`
  every page starts with. What needs an account says so instead of failing: the Assistant
  button (and `/`) explains itself, and the card dialogs show a note where Attachments go.
  There's no account menu, encryption, or billing there. Search is the in-tab keyword search an
  encrypted board uses (`localSearch.ts`). The top bar is written out again in `Demo.tsx`, so a
  button added to the real one in `App.tsx` needs adding there too.
- **Done = the last lane.** Cards carry no checkbox; the lane is the status. A ✓
  appears on hover or keyboard focus (a reopen arrow in the last lane), `x` does the
  same, and the card editor has Mark done / Reopen, which is the path on touch
  screens.
- **Adding a card.** The + in a lane's header opens the full `// NEW_CARD` dialog
  (`src/client/NewCard.tsx`): title, notes, lane, due date, tags, and files in one go.
  Nothing is added until Add card, so the X or Esc leaves no empty card behind (they ask
  "Discard changes?" first if anything was typed or a file is waiting), and the
  card goes in as one change, so one Undo takes it back out. Files picked, dropped, or
  pasted wait in the dialog and upload once the card exists; if one fails, the card stays
  and the button retries the upload. "Add a card" at the bottom of a lane (and `n`) is
  still the quick way: type a title and hit Enter, or paste a list to add one card per line.
  A title that ends in `#tags` is tagged as it's added: "Write a haiku #agent" becomes the card
  "Write a haiku" with the tag `agent` (see Tags for the rule). That goes for quick add, each
  line of a pasted list, and the dialog's title, where the tags move down into the Tags field
  when you leave the title (or hit Add card), so you can see them and take them back out.
- **Editing a card.** Nothing changes until Save (or Enter in the title or tags). The X in
  the top corner and Esc close the editor and throw the edits away, so opening a card to
  read it can't change it by accident; that covers the title, notes, due date, tags, and
  the lane. An untouched card closes at once. If something was edited, the X or Esc shows
  "Discard changes?" where the footer buttons were, with Keep editing and Discard; Esc again
  means Keep editing, so mashing Esc never loses work (`src/client/Discard.tsx`). A click
  outside closes an untouched card and does nothing once something has been edited. Files are the exception: they upload and come off as you go. Mark done, Reopen,
  and the Move to buttons are actions of their own: each saves the edits and then moves the card.
- **Tag suggestions.** The Tags field in both card dialogs (`src/client/TagField.tsx`)
  shows the tags already on the board above the input, most used first (`tagsByUse` in
  `src/shared.ts`). Typing narrows them, a tap or click adds one, and Tab takes the first
  match. It reads the board in the tab, so it works on an encrypted board.
- **On a phone.** Up to 560px wide, the card dialogs take the whole screen with 12px
  padding and size to the space above the on-screen keyboard, so Tags and the buttons stay
  reachable while typing. Android Chrome shrinks the page for the keyboard
  (`interactive-widget=resizes-content` in `index.html`); iOS Safari doesn't, so
  `src/client/viewport.ts` copies the visual viewport's height and offset into `--vvh` and
  `--vvt` for the stylesheet. On any touch screen, buttons are 40px, keyboard-shortcut
  hints are hidden, and fields are 16px, because iOS zooms the page on anything smaller.
  The Theme button leaves the top bar on a phone; it's in the account menu.
- **The top bar.** "Need you", a session count, due stats, and a tag filter all add to
  the bar, and the assistant panel takes 360px from it, so the bar is measured instead of
  guessed at with media queries (`src/client/topbarFit.ts`). When the buttons don't fit it
  gives up space one step at a time and stops at the first step that fits: the search box
  becomes its icon (click it or press `⌘K` and it opens across the bar), then Undo, "need
  you", Sessions, and Assistant drop to icon plus count, then the open / due / overdue
  summary goes, and last the tag filter chip moves to its own row under the bar. A phone
  always puts the chip on its own row. The steps are a word list in the bar's `data-tight`
  attribute, and `styles.css` does the rest. There's one count of what's waiting on you: "need
  you" adds up the open questions (`// QUESTIONS`) and the sessions stopped at a prompt
  (`// SESSIONS`), and the Sessions button next to it only says how many sessions are live.
- **Keyboard and screen readers.** Every button has a name: icon-only ones carry an
  `aria-label` (the account button is "Account", not the email address). The account and
  lane menus are `role="menu"` with `menuitem` children, the other popovers are
  `role="dialog"`, and each button says which it opens with `aria-haspopup`. Opening a
  popover moves focus into it, Esc or a click outside gives focus back to its button, and in
  a menu the arrow keys, Home, and End move between items and Tab closes it (`Popover` in
  `src/client/Board.tsx`). The card editor, New card, and Encryption are modal: native
  `<dialog>` elements opened with `showModal()`, each with `role="dialog"`, `aria-modal="true"`,
  and a name (the editor's is "Edit card: " plus the card's title). The browser keeps Tab
  inside an open one. Closing it gives focus back to what opened it: the card for the editor
  (found again by id when a move redrew it in another lane), the lane's + for New card
  (`useModal` in `src/client/modal.ts`; React takes these dialogs off the page instead of
  closing them, and the browser only hands focus back on a close). The card editor and New card
  open with focus on the title. On a touch screen the editor focuses the dialog instead, so the
  keyboard doesn't cover a card you only meant to read.
- **Moving a card on a phone.** Two ways. Open the card and tap a lane in the **Move to** row
  under the title (touch screens only; the current lane is marked): that moves it right away,
  keeps any other edits, and closes the card, so it's two taps from the board. Or long-press
  and drag. Up to 900px wide the board shows one lane at a time, and holding the card at the
  left or right edge brings in the next lane: one lane after 0.4 seconds, and one more only
  after another 2.5 seconds of holding, so it can't run to Done on its own. The 44px edge
  strips are for scrolling, so a card let go there lands in the lane that fills the screen,
  not the sliver of the next one (`collision` and `stepBoard` in `src/client/Board.tsx`).
  dnd-kit's own sideways auto-scroll is off at that width; wider boards still use it.
- **Sorting a lane.** A lane's menu (the dots) has Sort by: due date, title A–Z, newest
  first, oldest first, recently updated, and Manual order. The choice is a setting on the
  lane (`Lane.sort`), saved with the board, so it holds across reloads and follows the
  account to any browser. A sorted lane stays sorted: a card that's added, edited, or moved
  in falls into place, the menu marks the current sort with `$`, and the lane head says
  "by title". Nothing is reshuffled in storage. `shownCards` in `src/shared.ts` gives the
  order a lane displays, the board uses it, and so does the text board agents read over MCP
  (which adds "sorted by title" to the lane line). Dragging a card to a new spot inside a
  sorted lane switches that lane to Manual order and keeps what's on screen, as one change
  (`setLaneManual`). Undo covers picking a sort and leaving one. Cards with no due date go
  last, and ties keep the order they had. On an encrypted board the server can't read titles
  or dates, so it leaves the cards in stored order and the browser sorts its decrypted view;
  the sort name itself isn't encrypted. `npm run check:sort` covers all of it.
- **Clearing and deleting a lane.** Clear all cards and Delete lane, in a lane's menu, take two
  taps on the same item. The first changes its label to say what the second will do ("Tap
  again to clear 21 cards", "Tap again to delete Doing and its 3 cards") and changes nothing;
  closing the menu starts over. Both are still one Undo. Toasts after something is removed (a
  cleared or deleted lane, a deleted card, a removed file) say how many and stay 10 seconds
  instead of 5. Up to 900px wide, the toast moves to the top of the screen while a quick add
  is open, so Undo never covers Add card.
- **Tags.** A card can carry up to 10 tags, like `#agent` for work an AI agent owns.
  Tags are lower case with dashes for spaces, and only letters, digits, `-` and `_`
  (`cleanTag` in `src/shared.ts`). Edit them in the card editor as a space-separated list.
  Click a tag on a card to fade out every card without it; click again, or the chip in
  the top bar, to clear. While a filter is on, each lane's count reads matches / total
  ("2 / 22"). The filter belongs to the tab and isn't saved. On an
  encrypted board each tag is its own JWE like every other field.
- **Tags typed in a title.** `splitTitleTags` in `src/shared.ts` pulls trailing `#tags` off a
  title a person types for a new card. It reads only the end of the title, one word at a time,
  and stops at the first word that isn't a tag, so a title meant literally stays as typed. A
  word counts as a tag when it follows a space, is `#` plus only letters, digits, `-` or `_`
  (32 at most), and has a letter in it. So "Fix login #agent #shop-api" is "Fix login" with two
  tags, and these are left alone: `#123` (an issue number), `C#`, `foo#bar`, "Tag a card #agent
  first" (not at the end), `#agent.` (punctuation), and a title that is nothing but tags. Tags
  are lower-cased and repeats dropped. Past 10 tags the words left over stay in the title, and
  `#needs-ceo` stays in the title because only `ask_ceo` sets it. It runs in the tab
  (`App.tsx`, `Demo.tsx`, `NewCard.tsx`) before anything is saved, so the demo board gets it
  and an encrypted board seals the title and each tag separately. It does not run on a title
  being edited (the card editor has a Tags field right there, and a saved title shouldn't
  change shape under you), and it never runs on titles from agents over MCP or from the
  assistant: those pass `tags`. `npm run check:tags` covers the rule.
- **Markdown notes.** Open a card and its notes read as markdown: `#` headings, bullet and
  numbered lists, `- [ ]` checkboxes, links and bare URLs, `` `code` ``, fenced code blocks,
  bold, italic, strikethrough, quotes, and `---` rules. A single line break stays a line break.
  Click the notes, press Enter or `e` on them, or use Edit to get the plain textarea; leaving it
  (or ⌘/Ctrl+Enter) shows the rendered view again. Checkboxes can be ticked without editing.
  A card with no notes opens on the textarea. Notes are still stored as plain text, so search,
  MCP, and encryption see exactly what they did before; on an encrypted board the rendering
  happens in the tab, after decryption. Card faces still show only the `notes` chip.
  **Raw HTML is never rendered.** `src/client/Markdown.tsx` is a small renderer of its own that
  builds React elements and never uses `innerHTML`, so a `<script>` or `onerror=` in a note is
  just text, and links only take `http`, `https`, and `mailto` and open in a new tab with
  `rel="noopener noreferrer"`. It's hand-rolled so there's no parser or sanitizer dependency to
  trust on a shared origin (see "Accepted risk" below). `npm run check:markdown` renders a
  hostile note and fails if anything but the renderer's own tags and attributes comes out. Run
  it after touching the renderer.
- **Live sync.** Board state is Agents SDK synced state, so every open tab
  updates at once. Changes animate with the View Transitions API. Cards the
  assistant touches flash briefly.
- **Undo and redo.** Every change is undoable (⌘Z or the Undo button), including a
  whole assistant turn as one step, and an undo can be redone (⇧⌘Z, Ctrl+Y, the Redo
  button, or Redo on the toast). The last 30 steps are kept. A new change clears redo.
- **Themes.** Auto, which follows the OS, plus 11 fixed themes. Hover to preview,
  click to keep. Your choice syncs to your account and is cached locally so the
  page never flashes the wrong theme. Each sign-in email is its own account, so a
  new one keeps the theme this browser already uses until you pick one there
  (`themeChosen` on the board).
- **Readable color.** Each theme's `--accent` is for fills, borders, the `//` slashes, and
  the `$` marker. Accent-colored text under 18px uses `--accent-text` instead, the same hue
  moved until it reads at 4.5:1 on the theme's `--bg` and `--surface` (Paper: `#B24800`
  where Signal Orange `#E85D00` is 3.5:1). Small text on an accent fill, like the count
  badges, uses `--badge-ink`, which is dark ink in the themes where white falls short.
  `--muted` holds 4.5:1 on `--bg` and `--surface` too. A new theme sets all four.
- **Two assistants, one transcript.** The first time the chat opens, the tab downloads
  Needle 3 (35 MB, once; Cache Storage after that) and runs it in a Web Worker. A message
  goes to it first: the board's lane names and a handful of verb tools (finished, started,
  reopen, move, set a date, add, delete) are the schema, the card is named in the person's
  own words and matched to a title on the client, and the turn is applied locally only when
  the engine's confidence, the card match, and a few plain-language checks all clear
  (`src/needle-tools.ts`). Everything else, including questions, notes, anything with two
  clauses, and anything the small model is unsure of, goes to GLM exactly as before. A local
  turn runs the same board tools under one undo step and is written into the chat transcript
  by `TodoAgent.applyLocal`, so undo, the ✓ lines, and every open tab see it the same way.
  The footer under the message box says where the assistant runs in plain words ("runs in your
  browser · cloud model as backup") and which path handled the last message; the model names
  are in its tooltip. Local turns are
  free and don't count against the daily cap. `bench/needle.mjs` measures the policy.
- **Cost guard.** The assistant is capped per user per day: `FREE_DAILY_CHATS` (30)
  on the free plan and `PRO_DAILY_CHATS` (150) with a Stripe subscription. The chat
  shows a meter and an upgrade button at the cap. The board and MCP are never capped.
  Sign-in is limited by `ALLOWED_EMAILS` and protected by Turnstile.
- **Code guessing.** A sign-in code allows 5 tries, claimed in one atomic update so parallel
  requests can't share a try, and only the request that deletes the code gets a session. Across
  every code sent, an email gets 10 guesses an hour and 20 a day, and an IP gets 30 an hour
  (`login_limits`, migration 0004). Sending a new code doesn't reset those. Someone who burns
  an email's budget locks its code sign-in for up to a day; Google and Microsoft still work.

## // END_TO_END_ENCRYPTION

User menu → **Encrypt with a passphrase…** encrypts the board in the browser. From then on the
server, the cloud model, outside agents, and anyone reading the database see only ciphertext.
Any device opens the board with the passphrase, and nobody opens it without one.

**Format.** It's all open standards, so the data never depends on this app (`src/sealed.ts`):

- The board key is a random 256-bit AES key, written as a JWK (RFC 7517).
- The **envelope** is that JWK encrypted to the passphrase as a compact JWE (RFC 7516) with
  `alg: PBES2-HS512+A256KW`, `enc: A256GCM`, `p2c: 600000` (RFC 7518 §4.8, PBKDF2-HMAC-SHA512).
  The passphrase is NFC-normalized UTF-8. The envelope sits on the board as `sealed.envelope`,
  next to `sealed.kid`.
- Every lane name, card title, note, due date, attachment name and type, and chat message is its
  own compact JWE: `alg: dir`, `enc: A256GCM`, `kid` = the board key's id, with a fresh random IV.
- Attachments are uploaded as the same kind of JWE, with name and type in `X-Sealed-Name` and
  `X-Sealed-Type`. R2 keeps no name, type, or card for them. The real file size is computed
  exactly from the stored size (`sealedFileSize`).
- **Key proof:** AES-GCM over 32 zero bytes with an all-zero IV under the board key (`keyProof`).
  The server keeps only its SHA-256 (`seal_meta.check` in the agent's SQLite), and turning
  encryption off or changing the passphrase needs the proof. A signed-in session alone can't do
  either. Boards encrypted before the check existed get one from the first tab that unlocks them.

**Getting data out.** Encryption → **Download encrypted backup** saves the board exactly as the
server holds it. Then:

```sh
TASKS_PASSPHRASE='…' node scripts/decrypt-board.mjs < tasks-encrypted-2026-09-29.json > board.json
```

It reads stdin and writes the plain board to stdout, and asks on the terminal if
`TASKS_PASSPHRASE` isn't set. Any JOSE library works the same way. Python's `jwcrypto` was checked
against a real board, but it caps PBES2 at 16,384 rounds, so raise
`jwcrypto.jwa.default_max_pbkdf2_iterations` first.

**What the server does.** The ops in `src/shared.ts` pass sealed values through, so moves,
deletes, reordering, and undo work on ids without reading anything. `assertSealedBoard` runs on
every change and rejects any field that isn't a JWE under the board's `kid`. That's what keeps
plaintext off an encrypted board from any path: MCP, the cloud model, a stale tab, or a bug.

- **Turning it on or off** re-encrypts (or decrypts) every field and file in the tab. Files are
  re-uploaded with `?stage=1`, and the whole board goes to `enableEncryption` or
  `disableEncryption` in one call. An encrypted board refuses plain uploads, staged or not, except
  for 15 minutes after `beginDisable`, which takes the key proof. Encrypted uploads must be one
  JWE under the board's `kid`, checked before anything is stored. Staged files that never make it
  onto the board are collected with the other orphans. The agent checks that it's the same board by id
  (`sameShape`), swaps it in, and erases the undo and redo history, the chat, the search index,
  and every R2 object the new board doesn't use.
- **Changing the passphrase** only rewraps the key (`changePassphrase`). Fields aren't
  re-encrypted. Undo never brings an old envelope back.
- **Forgotten passphrase:** the unlock screen can throw the board away (`resetEncryptedBoard`),
  files included, and start over empty. That's the only recovery there is, so it can't need the
  key. Instead, each device remembers the board was encrypted (`tasks-sealed:<user id>` in
  localStorage). When a board comes back unencrypted and no tab on the device turned it off, the
  app stops on a warning instead of showing it.
- **Remember on this device** keeps the key in IndexedDB as a non-extractable `CryptoKey`, so
  scripts can use it but can't read it. Without it, the key lives in memory until the tab closes.

**What changes on an encrypted board.**

- The assistant is Needle in the tab only. It runs on the decrypted board, and its tool calls
  and your message are encrypted before `applyLocal`. There, every call is parsed by its tool's
  schema, and every string has to be an id on the board or ciphertext under its key.
- The chat SDK stores whatever messages a client sends before any hook runs, so `TodoAgent`
  wraps its `onMessage` and refuses chat requests, message writes, and tool results on an
  encrypted board. `persistMessages` then keeps only messages the server built or already has.
- Search runs in the browser (`src/client/localSearch.ts`) and matches keywords with prefixes,
  not meaning.
- MCP tools all answer with an error that says the board is encrypted.
- Lane name clashes are checked in the tab, since the server can't compare names.

**What it doesn't hide.** Your email, the number of lanes, cards, and files, file sizes,
timestamps, card order, your theme, and usage and billing records. Also: Durable Objects allow
neither `PRAGMA secure_delete` nor `VACUUM` (both were tried), so rows erased when encryption
goes on can linger in free pages of the database file, and Cloudflare keeps 30 days of
point-in-time recovery. Text stored **before** encryption was turned on can outlive the switch
there. Text written after encryption is on is never plaintext on the server. For a board that
never had plaintext, turn encryption on before adding anything.

The server stores the envelope, so whoever runs it could try to guess weak passphrases offline.
That's the reason for the 12-character minimum and the 600,000 rounds.

**Accepted risk: a shared origin.** Tasks lives at `askscottpierce.com/tasks` on purpose, so
its pages build traffic for the main domain. `Path=/tasks` on the cookie isn't a security
boundary, though. Any script on `askscottpierce.com` (an XSS bug in another app, a compromised
dependency, a third-party script) runs as the visitor. It can call the Tasks API with their
session, mint an access token, and use a key they chose to remember on this device to decrypt
their board. "Remember on this device" is on by default anyway, for convenience across these
apps. Keep third-party scripts off the domain, and treat every app on it as part of the Tasks
security boundary. The fix, if that ever changes, is a separate origin such as
`tasks.askscottpierce.com`. What does help on a shared origin: the agent WebSocket, every non-GET
`/api/*` call, and the consent form refuse requests whose `Origin` or `Sec-Fetch-Site` says
they came from anywhere else, including sibling subdomains that `SameSite=Lax` lets through
(`fromElsewhere` in `src/server.ts`). The Stripe webhook is exempt, and MCP uses bearer tokens.

## // CONNECT_AN_AGENT

Claude, ChatGPT, Glean, Claude Code, Cursor, VS Code, Codex, and any other MCP client
can work the board. The page at **/tasks/connect** opens with a headline for people running
coding agents and the four-step `// QUICK_START` for Claude Code (`#quick`), then shows the
server URL, setup steps for each client (`#add`, Claude Code's tab first), the starter prompt (`#prompt`), connected apps and tokens (`#apps`), the
one-command Sessions setup (`#sessions`), how the `#agent` tag, questions, claims, and the
event feed fit together (`#working`), and the tool list (`#tools`). It's the first item in
the user menu, the `// START_HERE` block on an empty board links to it, and so do the
Sessions list and the "No agent connected yet" line, chip, and card note a board shows until
its first agent connects (`// HOW_IT_WORKS`). Signed out, the landing page, the demo board's
strip, and the not-found page link to it too.

- **The page is public.** Someone deciding whether to sign up can read every step first.
  Signed out, the two parts that read or change an account (connected apps, tokens) become a
  "Sign in to create a token" link, which goes to `/tasks/?next=/tasks/connect#…` so sign-in
  lands back on the same section. The top bar's back link goes to the board signed in and to
  the landing page signed out. `App.tsx` routes `connect` ahead of the sign-in check and
  passes `signedIn`; the Worker hands every page the same HTML and never gated it.
- **The quick start.** Four steps: sign in, **Add a sample agent card**, **Copy the command**,
  paste it in a terminal. The same `QuickStart` component is the empty board's `// START_HERE`
  (`// HOW_IT_WORKS`, First run). On the Connect page, which has no board connection, the
  sample button leaves a note in `sessionStorage` and goes to the board, which adds the card.
  Copy the command creates an access token named "Claude Code quick start" and copies one line
  (`quickStartCommand`):

  ```sh
  claude mcp remove tasks -s local >/dev/null 2>&1; claude mcp add --transport http tasks https://askscottpierce.com/tasks/mcp --header 'Authorization: Bearer tasks_…' && claude 'Work the agent cards on my Tasks board. Call get_started on the tasks MCP server first and follow what it returns.' --allowedTools mcp__tasks
  ```

  - No `/mcp` Authenticate and Allow round trip: the token is the sign-in. It's shown once, in
    the command, and the page says so and says what the command changes. The token is typed on
    the command line, so it also stays in the shell's history; the page says that too, and that
    it can be revoked under Connected apps. OAuth, which leaves no
    token on disk, is the Claude Code tab under `#add`.
  - `claude mcp add` refuses a name that's already there, so the local-scope entry is removed
    first; that fails quietly when there isn't one. The new entry is local scope (the folder
    it's run in), which wins over a `tasks` in user or project scope.
  - Everything is single-quoted and the prompt is one plain line with no `$`, `!`, quotes, or
    backticks, so no shell expands anything. The prompt comes before `--allowedTools`, which
    takes a list and would swallow it. `--allowedTools mcp__tasks` lets Claude use the board's
    tools without a prompt per call; file edits and shell commands still ask. The page says
    both halves under the steps: the board's tools include deleting cards and lanes, which
    Undo takes back, and writing files and running commands aren't pre-approved. Write, Edit,
    and Bash stay out of `--allowedTools` on purpose; the sample card is built to not need them.
  - Step 4 says what happens and no more: Claude Code may ask once whether you trust the
    folder, and to pick Yes there, because that prompt starts on "No, exit" and Enter alone
    quits (the folded line says the same); a question lands on the card, and an answer gets a plan in the notes and the card
    in Done. The lede after step 2 says two steps are left, not that Claude Code is working.
  - The front page tells the same four steps under `// CONNECT_AN_AGENT`, without the buttons
    (a signed-out page can't mint a token), with a Sign in to start button. The OAuth command
    sits under them as the other way.
  - Quick start tokens that were never used are commands that were copied and never run. The
    button revokes those before it makes a new one, so clicking it again doesn't eat the 10.
  - Codex has the same shape on its tab (`codexQuickCommand`): `export TASKS_TOKEN=… && codex
    mcp add tasks --url … --bearer-token-env-var TASKS_TOKEN && codex '<prompt>'`. Cursor, VS
    Code, and the chat apps have no terminal command to start them, so they keep their steps.
  - The flags were checked against `claude mcp add --help`, `claude mcp remove --help`,
    `claude --help` (2.1.289), and `codex mcp add --help` (0.150.1). Check again when they change.
- **The starter prompt is one line.** Step 03 is `STARTER_LINE` from `src/agent-rules.ts`: it
  tells the agent to call the MCP tool `get_started`, which returns the working rules
  (`workingRules` in the same file). The rules live on the server so the pasted prompt is easy
  to quote, works in every client, and can't go stale. A second tab, "The full rules", shows
  the same text for reading or pasting whole. The rules cover: only `#agent` cards; a session
  id, plus `agent`, `machine`, and `project` for `claim_card`, none of which the agent runs a
  command to find; `get_board` with `tag: "agent"`; ANSWERED cards first; claim, `get_card`, move to
  Doing; a `STATUS:` line kept under any `ANSWER:` lines, which `update_card` would wipe if the
  notes weren't sent back whole (leaving `tags` out keeps the tags); `ask_ceo` with the session
  id, keep the claim, move on; Done and `release_card`; and at the very end, hold nothing.
  - **The session id needs no shell.** `get_started` makes an id for the call (`tasks-` and 8
    characters; nothing is stored until it claims) and the rules say to use it. That works in
    every client and under the quick start's permissions, where `echo $CLAUDE_CODE_SESSION_ID`
    would be a Bash approval. With the Sessions hooks installed the board already has a row
    under Claude Code's own session id, so a made-up id would be a second row. For that case
    the hook prints `Tasks session id: <id>` on `SessionStart`, which Claude Code adds to the
    session's context, and the rules say to use that id when the line is there. One row either
    way. A machine whose hooks were installed before this prints nothing and gets the second
    row until the setup command is run again. The Connect page's copy of the rules has no
    server to make an id, so it says to make one up once.
  - **Waiting for an answer.** Nothing calls an agent when the owner answers, and an agent
    with only MCP tools can't sleep. So the server holds: `wait_for_answer` takes the ids of
    the cards the agent asked on and returns the moment one is answered, or after 30 seconds
    (`seconds`, at most 45, under the 60 seconds most MCP clients allow a call). The rules
    have the agent call it again for up to 10 minutes, then say plainly "answer on the board,
    then tell me to check the board" and stop. It's the same in an interactive Claude Code
    session, a `claude -p` run, and any other MCP client. The MCP server stays stateless: the
    Worker rereads the cards every 2 seconds (`cardDetail`, at most 30 reads a call) and keeps
    nothing; a client that hangs up ends the loop. Each call counts as hearing from the
    session, at both ends of the hold, so an agent that's waiting never reads stale and keeps
    its cards (`// SESSIONS`). A card you delete, or move to the last lane
    with its question still open, ends the wait too: the answer says the card is gone or
    finished and to stop waiting on it, the same rule that ends its claim (`// SESSIONS`).
  - **When it can't go on.** A refused tool call, a missing tool, a command that keeps
    failing: the rules have the agent call `ask_ceo` on the card with what it needs and options
    that are whole actions the owner can settle from the board, so it lands on the card face and
    in "need you". The one it recommends has to work without the missing permission: "Do it
    another way: …" with the tools it has (write the result into the card's notes, say), or
    "Skip this card" when there's no other way. "I've allowed it in the terminal, try again" can
    be offered, never recommended, and once per card: in a headless session, or one that only
    runs what was approved up front, there's nothing in the terminal to allow, so the retry is
    refused again and the agent would ask the same thing twice. Writing blocked in
    the notes isn't enough, because nobody sees it. It can't cover a permission
    prompt that's still open in an interactive terminal, since the agent is stopped inside the
    tool call; the Sessions hooks report that one as a session that needs input.
  - **The rules only use tools the quick start approved.** The copied command allows the
    board's tools (`--allowedTools mcp__tasks`) and nothing else, and step 4 says "Nothing else
    needs approving in the terminal". So nothing in the rules reaches for another tool on its
    own: no shell, no sleep, no background command.
  - **The event feed is there when you ask for it.** The agent starts it only when the
    owner's prompt asks for the event feed in so many words, and it has Claude Code's Monitor
    tool. It used to start it whenever the Sessions hook had printed `Tasks event feed:
    installed`, which put an approval prompt in a terminal nobody was watching, and a denied
    one left the session reading "needs input · wants to use Monitor". The hook still prints
    the line, and the rules say to leave it alone. The feed adds new cards, edits, and deletes
    to what `wait_for_answer` hears; Claude Code asks once before it runs the script unless
    it's been allowed. With the feed running, the agent still calls `wait_for_answer` while a
    question of its own is open, since that's what tells the board it's waiting.
  - When a tool's behavior changes, check `src/agent-rules.ts` against `src/tool-docs.ts`,
    `src/mcp.ts`, and `src/shared.ts`.
- **The page stands on its own.** Someone using the hosted app has no checkout, so the page
  never points at this file. Its one command installs `scripts/tasks-presence.mjs` and
  `scripts/tasks-events.mjs` into `~/.config/tasks/`, next to the token (`// SESSIONS`), and
  "Do it by hand" still offers both as downloads (bundled as text at build time). Off the
  hosted origin, its commands set `TASKS_PRESENCE_URL` and `TASKS_URL` to the server they were
  copied from.
- **One list of tools.** `src/tool-docs.ts` holds every MCP tool once: the description an agent
  reads and the line a person reads on the Connect page. `src/tools.ts` and `src/mcp.ts` take
  their descriptions from it, and `mcp.ts` fails to compile if it lists a tool that isn't
  registered, so the page can't drift from the server.

- **Endpoint.** `/tasks/mcp`, Streamable HTTP, stateless. Tools: `get_started` (the working
  rules, above), `get_board`, `get_card`,
  `search_cards`, the seven board tools from `src/tools.ts`, `ask_ceo` and `wait_for_answer` (`// QUESTIONS`), and
  `claim_card` and `release_card` (`// SESSIONS`). Board changes over MCP sync live and are undoable, one undo step per call; claims aren't
  board changes. `get_board` and `search_cards` take an optional `tag`, so an agent
  can list just its own cards (`tag: "agent"`). `add_cards` and `update_card` take `tags`,
  and `update_card` replaces the whole list when it's passed and keeps it when it isn't.
- **Reading a card.** `get_board` is the overview: it shows the first 120 characters of each
  card's notes, says how many more there are (`… [+480 more characters]`), and lists file
  names. `get_card` returns one card in full: all of the notes, lane, tags, due date, the
  question and answer, and each attachment's id, type, and size. Attached PNG, JPEG, GIF,
  and WebP images come back as MCP image content (4 MB each, 8 MB a call), so an agent can
  look at a screenshot, and text, Markdown, CSV, and JSON files up to 32 KB come back as
  text. `files: false` skips the contents. It reads R2 under the token owner's own prefix.
- **What a write returns.** The summary of the change and one line of lane counts
  (`Board now: To do 21 · Doing 0 · Done 3`), and `add_cards` adds the new cards' ids in
  the order given. It used to be the whole board, which cost an
  agent thousands of tokens a call. The in-app assistant still gets the full board.
- **OAuth (most clients).** The client only needs the URL. It discovers the OAuth
  server, registers itself (Dynamic Client Registration, or a Client ID Metadata
  Document), and sends the person to `/tasks/oauth/authorize`. They sign in if
  needed, then see a consent screen with the app's name and where it returns to,
  and choose Allow. Access tokens last an hour and refresh tokens 90 days. Connected
  apps are listed on the Connect page, and disconnecting one kills its tokens.
- **Access tokens.** For the quick start command, and for clients that take a pasted token (Codex, Glean's
  API Key method): `Authorization: Bearer tasks_…`. Per user, at most 10, stored as
  SHA-256 hashes in D1 (`api_tokens`). Only a browser session can create or revoke
  them.
- **Glean.** An admin adds it under Admin console → Platform → Tools → Import tools
  from MCP server, with the **Dynamic Client Registration** auth method. Each Glean
  user then connects their own board on first use. The API Key method with an access
  token also works, but everyone the tool is published to shares that one board.
- **Discovery is at the domain root.** OAuth metadata lives at
  `askscottpierce.com/.well-known/oauth-authorization-server` (RFC 8414 derives it
  from the issuer, which is the origin), so this app is the OAuth server for the
  whole domain. `wrangler.jsonc` routes only that path and
  `/.well-known/oauth-protected-resource/tasks/*` here. Nothing else on the domain
  can use them.
- MCP calls don't hit Workers AI, so the daily chat cap doesn't apply to them.
- An end-to-end encrypted board is closed to agents. Every tool returns an error saying so.

## // AGENT_EVENTS

An agent session on your own machine can hear about your changes to `#agent` cards the
moment you make them, so you can answer it from the app instead of hunting down a terminal.

```sh
echo 'tasks_…' > ~/.config/tasks/token && chmod 600 ~/.config/tasks/token
node scripts/tasks-events.mjs     # one JSON object per line on stdout
```

In Claude Code, run that under the Monitor tool and each line wakes the session. The lead
agent definition (`~/.claude/agents/lead.md`) does this itself. The working rules from
`get_started` start it only when your prompt asks for the event feed, because Monitor is an
approval prompt in the terminal and `wait_for_answer` already covers waiting. The Sessions setup command (`// SESSIONS`)
installs the script as `~/.config/tasks/tasks-events.mjs` along with the token.

- **One project per lead.** Tag each card with its repo's folder name (`#receptionist`) next to
  `#agent`, and run one lead per repo. `tasks-events --tag receptionist` passes on only that
  project's cards, so leads in different repos never hear each other's work. Filtering happens
  in the script; the server sends every `#agent` and `#gauntlet` change to every connection.
- **Two kinds of agent card.** `#gauntlet` cards ride the same feed (`// GAUNTLET`). `--require`
  keeps the two apart in one repo: `--tag receptionist --require agent` for the lead,
  `--require gauntlet` for the gauntlet agent. A card has to carry every `--require` tag.

- **Direction.** Your machine dials out to `wss://askscottpierce.com/tasks/events`, so nothing on
  it accepts connections: no tunnel, no open port.
- **Auth.** A personal access token, in the `Authorization` header or, for WebSocket clients
  that can't set headers, as a second subprotocol after `tasks-events`. Never in the URL. The
  Worker checks it and doesn't pass it on.
- **Answers.** When the card had a question (`// QUESTIONS`), `answered` also carries `answer` and `question`.
- **Events.** First a `hello` with every open `#agent` or `#gauntlet` card, on each connect, so nothing is lost
  while offline. Then one line per change: `added`, `tagged`, `answered` (`#needs-ceo` came
  off), `edited`, `moved`, `deleted`. Each carries the card's id, title, lane, and tags.
- **Only your changes.** Edits from the app, its assistant, and Needle publish. Changes an agent
  makes over MCP don't, so an agent never wakes itself (`actor` in `TodoAgent.mutate`).
- **Kept apart from the board.** The sockets live in their own Durable Object, `TaskEvents`
  (`src/events.ts`), one per user. The Agents SDK syncs the whole board to every socket on
  `TodoAgent` and lets it call board actions; these sockets only ever receive event lines.
  Pings are answered without waking the object, so an idle connection costs nothing.
- **Encrypted boards** have no feed, the same as MCP.
- The other direction, sessions telling Tasks what they're doing, is `// SESSIONS` below.

## // QUESTIONS

When an agent needs you to decide something, it asks on the card and you answer with one tap.

- **Asking.** The MCP tool `ask_ceo` takes a card id, a one-line question, 2 to 4 options, and
  optionally which option the agent recommends (counting from 1). The card gets `#needs-ceo` and
  holds the question as its own field (`ask` on the card in `src/shared.ts`), not as text in the
  notes. Asking again replaces the question. It also takes `session_id`, the id the agent
  claimed the card with, so the board can say who's waiting (below).
- **Answering.** The card face shows the question with a button per option, the recommended one
  outlined and marked `REC` ("recommended" where there's room). On a touch screen the buttons
  on the card face take two taps, since that's where a stray tap lands and an answer reaches
  the agent at once: the first turns the option into "Send: …?", and a second tap on the same
  one within 5 seconds sends it. A tap anywhere else, or on another option, starts over. With
  a mouse it's one click, and in the questions list and the card editor it's one tap everywhere. The card editor shows the same plus a box for a typed answer. While anything is
  open, the top bar shows a count ("2 need you"); it opens every open question in one list, so
  they can be cleared in a row. When the bar is short on room, and always on a phone, the
  count is all that shows.
- **Who's waiting.** The session that asked reads `needs input` and `asked: <the question>`
  from the moment it asks until you answer: on its row in Sessions, on the session line of
  the card (the line's tooltip has the question; the question itself is right under it), and
  as one line under the question in the "need you" list: agent · machine · project, and how
  long the question has been open (`waiting 4m`). The agent keeps its claim while it waits,
  which is what keeps that line on the card. The mechanics are in `// SESSIONS`, under
  "A session that asked".
- **One count for everything waiting on you.** "Need you" also counts the sessions that are
  stopped at a prompt (state needs input, heard from in the last 5 minutes; see `// SESSIONS`),
  and lists them under the questions: project, what it wants, machine, and Copy resume command.
  Those can't be answered from the board, so the row is the way back to the terminal. Three
  questions and one blocked session read "4 need you" (`AsksButton` in `src/client/Ask.tsx`).
- **One decision counts once.** A session that needs input while it holds the claim on a card
  with an open question is the same decision as that question, whether it's waiting on the
  answer or stopped at a terminal prompt as well. It counts as the question, and the session
  shows as one line under it instead of as a row of its own. A blocked session that holds no
  card with a question still counts. An asker that stopped polling is still shown under its
  question, marked stale, so you know nobody is listening for that answer right now. The rule is `blockedSessions` in
  `src/presence-shared.ts`, and the top bar, the list, the demo, and the front page's sample
  bar all read it.
- **What an answer does.** It's one board change and one undo step ("Answer question"): the
  question comes off, `#needs-ceo` comes off, the answer is kept on the card (`answer`), and
  `ANSWER: … (asked: …)` becomes the first line of the notes so the history stays readable.
  Taking `#needs-ceo` off by hand clears the question without an answer.
- **The agent waits for it.** `wait_for_answer` over MCP holds for up to 30 seconds and
  returns as soon as one of the cards it was given is answered, with that card in full. It also
  returns when a card was deleted, was moved to the last lane with its question still open, or
  had its question cleared by hand. The working rules have
  an agent call it in a loop for up to 10 minutes (`// CONNECT_AN_AGENT`). No shell, no feed.
  Every call counts as hearing from the session, so it doesn't go stale while it waits.
- **The feed says it too.** The `answered` event on the feed (`// AGENT_EVENTS`) carries `answer`
  and `question`, so the agent acts on it without reading the card:
  `{"type":"answered","id":"c1a2b","title":"…","lane":"Doing","tags":["agent"],"answer":"Ship it now","question":"Ship now or wait?"}`.
  `get_board` shows an open question as `ASKING: … [1) … | 2) …]` and the last answer as
  `ANSWERED: "…" to "…"`, ahead of the notes. An `answered` event without `answer` still means
  what it always did: you took `#needs-ceo` off yourself.
- **Stuck is a question too.** An agent that can't go on (a tool was refused, something is
  missing) asks with `ask_ceo` what to do about it, so the card shows it and "need you" counts it.
- **The status line is on the card.** When a card's notes open with a `STATUS:` line (under
  any `ANSWER:` lines), the card face shows it as one line of small mono text, two lines at
  most, so nobody opens a card to see what its agent is doing (`statusLine` in
  `src/shared.ts`, drawn by `CardFace`). A card with an open question shows the question
  instead, and a card in the last lane shows neither.
- **Right after you answer, the card says what you answered.** The STATUS line an agent wrote
  before asking usually says it's waiting on you, and it stays in the notes until the agent
  rewrites it, some seconds after your tap. So an answer remembers the STATUS line the card
  had at that moment (`was` on `answer`), and while the card's STATUS is still that one, the
  face shows `answered: <your answer>` in its place. The agent's next STATUS line takes over;
  moving or retagging the card doesn't bring the old one back. A card with no STATUS line
  shows the answer the same way until it gets one. The rule is `faceLine` in `src/shared.ts`,
  and `npm run check:nudge` runs it. An encrypted board is the same as any
  other here: the browser has the decrypted notes, and nothing new is stored or sent.
- **Undo.** Undoing an answer puts the question back, but nothing tells the agent, the same as
  every other undo. If it already acted, say so on the card.
- **Encrypted boards** have no questions. They'd be stored unencrypted, and MCP is closed there.

For a lead agent's instructions:

```
When you need Scott to decide something, call ask_ceo on the card with a one-line question and
2 to 4 options that are each a complete action, and say which you recommend. Put the reasoning
in the notes under the status line. Pass your session id to ask_ceo, leave the card in Doing,
keep your claim on it, and move on. When an `answered` event arrives with an `answer`, act on
that answer; without one, reread the card.
```

## // GAUNTLET

Tag a card `#gauntlet` next to its project tag and an agent works it all night without asking:
it builds, a separate critic with fresh context judges the real result against the bar on the
card, the gaps become cards, and the next round starts. It's the Gauntlet Loop
(https://somethingbig.ai/gauntlet-loop) started from the app instead of a prompt.

```sh
cd ~/code/receptionist && tasks-gauntlet     # once per repo; then everything is in the app
```

- **The card.** Say the goal, the bar to beat (reference sites, screenshots, a test suite, a
  number), and a limit if you want one (`rounds: 6`, `until 07:00`). With no bar the agent
  finds one and writes it on the card. With no limit it stops when a critic round comes back
  clean, or when you move the card to Done or take the tag off.
- **It decides instead of asking.** A choice it can undo, it makes, and lists under `DECISIONS:`
  on the goal card for you to overrule. It asks one question per goal, at the end, with `ask_ceo`.
- **What it won't do without you.** Deploy, merge or push to main, force-push, delete data,
  send anything, spend money. Work stays on a branch, `gauntlet/<card id>`. Add `#ship-ok` to
  the goal card to let it merge and deploy that one goal once the build, the checks, and a
  critic round pass.
- **Not a lead's card.** Its cards carry `#gauntlet` and never `#agent`, so a lead agent leaves
  them alone and the two can run in one repo.
- **`scripts/tasks-gauntlet`** (install it on PATH next to `tasks-events`) runs
  `claude --agent gauntlet` in the foreground with permission prompts off
  (`--permission-mode bypassPermissions`) and `ANTHROPIC_API_KEY` unset so it bills the
  subscription. Start it under whatever keeps your sessions alive (relay-tty, tmux); it doesn't
  restart itself. Extra arguments go to `claude`. An agent file can't turn prompts off for its
  own main session, which is why the launcher does it. Claude Code wants that mode accepted
  once per machine by hand: `claude --dangerously-skip-permissions`.
- **What's taken away.** With prompts off, the launcher denies the tools a night shift never
  needs: Gmail, Drive, Calendar, Docs, the Cloudflare and Stripe servers, analytics, `sudo`,
  force-push, and questions in the terminal. Denies hold in that mode. The rest of the list
  above is the agent's instructions (`~/.claude/agents/gauntlet.md`), not a lock.
- **A restart loses nothing.** Status lines, the round log, and claims are on the board, so a
  session you start again reads where it was. A claim lapses after 15 minutes either way.

## // SESSIONS

The Sessions button in the top bar lists every Claude Code session that's reporting in, on any
machine: grouped by project, the ones waiting on you first. A row shows the state (working,
needs input, idle), the agent and machine, one line about its last action, and how long ago it
was heard from. After 5 quiet minutes a row is marked stale. "Copy resume command" copies
`cd <folder> && claude --resume <id>` for the machine it runs on. A session that never sent a
folder has nothing to resume, so its row has no such button; one that sent `X-Tasks-Link` shows
"open session" either way. A session that didn't say its project is listed under "No project",
and a machine it didn't name is left off the row. An agent with no hooks at all (Cursor, Codex,
anything that only speaks MCP) still gets a row, from its claims: see Claiming cards below.
The button's count is the
sessions that are live (heard from in the last 5 minutes, and not an MCP-only session that's
idle; see "A session that only speaks MCP" below), and it never turns orange: the ones that need input are counted on
"need you" beside it, in one list with the open questions (`// QUESTIONS`), so there's one
number to watch. A stale session isn't counted there. Claude Code's "waiting for your input"
notice puts every finished session in needs input after a minute, so without that cutoff the
count would only ever go up. A card that a lead agent has
claimed shows the same state line under its title, and its editor shows the session's whole
row, resume command included.

**It's presence, not a log.** Each session overwrites one row. Nothing is appended, and no
transcript, prompt, tool output, or Bash command is ever stored; Claude Code already keeps
transcripts in `~/.claude/projects` on the machine that ran them.

**What's stored**, per session: session id, project (the folder's name), the folder path (for the
resume command), machine, agent kind, state, the last-action line, when it started, and when it
was last seen. The last-action line is a tool name plus a file name (`Edit: server.ts`), a Bash
call's description when it has one (never the command), or Claude's own notification text
(`Claude needs your permission to use Bash`). For a session with no hooks it's a line
about the card, like `claimed "<card title>"` or `finished "<card title>"`. Rows are deleted
24 hours after they were last updated, when the session ends, and all at once when the board
turns encryption on. At most 200 are kept.

Per claim: the card's id, the session's id, the agent kind, and when it was claimed. While a
question that session asked on the card is open (`ask_ceo`), the claim also holds a copy of
the question and when it was asked, which is how the row reads `needs input` and `asked: …`
without that being written into the row. The copy comes off when you answer or the question is
taken back. A claim ends when its card is done or deleted, when it's released, when its
session ends, and 15 minutes after the session was last heard from; encryption erases them
with the rows. Card text is copied here in those two places and no others: a title in a
hookless session's last-action line, and an open question on its claim. A session's row is
made by its first hook report, its first `claim_card`, or an `ask_ceo` that names a session;
`wait_for_answer` only moves last-seen on a row that's already there. The privacy page
(`src/client/Legal.tsx`) says the same in plainer words; change them together.

**Install the hook** on each machine with one command. The Connect page shows it with a fresh
token filled in (`/tasks/connect#sessions`; "Create a token" is right there):

```sh
curl -fsSL https://askscottpierce.com/tasks/setup.mjs \
  | TASKS_TOKEN='tasks_…' \
    node --input-type=module -
```

- **What it changes.** It writes the token to `~/.config/tasks/token` (mode 600), puts
  `tasks-presence.mjs` and `tasks-events.mjs` next to it, and adds the seven hooks below to
  `~/.claude/settings.json`. Nothing else.
- **What it keeps.** Every hook and setting already in `settings.json`, in order; its hooks go
  after yours. Before it rewrites the file it copies it to `settings.json.tasks-backup-<time>`
  and prints that path: with `~` for your home folder, or in full when the file lives somewhere else.
  A second run changes nothing and makes no second backup. An event that already has a hook
  running `tasks-presence.mjs`, from any path, counts as done, so hand-added hooks pointing at
  a checkout aren't doubled. A symlinked `settings.json` is edited where it really lives.
- **What stops it, before anything is written.** A `settings.json` that isn't valid JSON, a
  token that doesn't start with `tasks_`, or a token the server refuses. It checks the token
  with one empty `POST /tasks/api/presence`, which stores nothing; with no network it says the
  token is untested and carries on. `--dry-run` on the end prints the plan, writes nothing,
  and sends nothing.
- **How it's served.** `scripts/tasks-setup.mjs` is the installer. The Worker answers
  `/tasks/setup.mjs` (`src/server.ts`; the Worker answers every `/tasks` address) with that file plus the two
  scripts and its own origin written into it (`buildSetup` in `src/setup.ts`), so one download
  is everything that lands on the machine and it can be read before it's run. The token goes
  in the environment, never in a URL. From a checkout, `TASKS_TOKEN=… node scripts/tasks-setup.mjs`
  installs the copies next to it.
- Run with no `TASKS_TOKEN`, it reuses the token already saved, which is how to pick up newer
  scripts later. `npm run check:setup` runs all of this against a throwaway HOME.

**Or by hand** (this goes in `~/.claude/settings.json`; merge it with any hooks already there).
It uses the same token file as `// AGENT_EVENTS`: `~/.config/tasks/token`, or `TASKS_TOKEN`.

```json
{
  "hooks": {
    "SessionStart":      [{ "hooks": [{ "type": "command", "command": "node ~/code/todo-agent/scripts/tasks-presence.mjs" }] }],
    "UserPromptSubmit":  [{ "hooks": [{ "type": "command", "command": "node ~/code/todo-agent/scripts/tasks-presence.mjs", "async": true }] }],
    "PostToolUse":       [{ "hooks": [{ "type": "command", "command": "node ~/code/todo-agent/scripts/tasks-presence.mjs", "async": true }] }],
    "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "node ~/code/todo-agent/scripts/tasks-presence.mjs" }] }],
    "Notification":      [{ "hooks": [{ "type": "command", "command": "node ~/code/todo-agent/scripts/tasks-presence.mjs" }] }],
    "Stop":              [{ "hooks": [{ "type": "command", "command": "node ~/code/todo-agent/scripts/tasks-presence.mjs" }] }],
    "SessionEnd":        [{ "hooks": [{ "type": "command", "command": "node ~/code/todo-agent/scripts/tasks-presence.mjs" }] }]
  }
}
```

`scripts/tasks-presence.mjs` reads the hook's JSON on stdin and posts about 200 bytes: session
id, folder, event name, tool name, file path, and notification text. The rest of the payload
never leaves the machine. It prints only on `SessionStart`, where Claude Code adds a hook's
output to the session's context: `Tasks session id: <id>`, so the agent claims cards under
the id this row has without running a command, and `Tasks event feed: installed` when
`tasks-events.mjs` sits next to it. It always exits 0, gives up after 3 seconds, and sends
tool-use events at most once every 30 seconds per session, except that the first tool event
after any other kind of event always goes (below, "A settled prompt clears"). The two events that fire constantly
(`UserPromptSubmit`, `PostToolUse`) run in the background with `async`. The rest run in line,
which costs about a tenth of a second each: a backgrounded `Stop` hook is killed when a
`claude -p` run exits, so the row would be left saying "working".
The machine name is the host's name, or `TASKS_MACHINE`. On a box without this repo, copy the one
file; it has no dependencies beyond Node 22. The Connect page (`/tasks/connect#sessions`) keeps the
same steps under "Do it by hand": a download of each script, and this JSON with a Copy button,
pointed at `~/.config/tasks/tasks-presence.mjs`. The Sessions list links there when it's empty ("Set up the
hooks") and when it isn't ("Add another machine"). When any row came from an agent with no hooks
(no folder and no link, which is what the quick start alone gives you), one line under the list
says why that row has no resume command and links there too ("add the session hooks").

**Or with no script, hooks of type `http`.** The same endpoint takes Claude Code's hook payload
directly:

```json
{ "type": "http", "url": "https://askscottpierce.com/tasks/api/presence", "timeout": 5,
  "headers": { "Authorization": "Bearer $TASKS_TOKEN", "X-Tasks-Machine": "$TASKS_MACHINE", "X-Tasks-Agent": "$CLAUDE_CODE_AGENT" },
  "allowedEnvVars": ["TASKS_TOKEN", "TASKS_MACHINE", "CLAUDE_CODE_AGENT"] }
```

The trade: an `http` hook sends the **whole** payload, which for `PostToolUse` includes the tool's
input and output, for `UserPromptSubmit` your prompt, and for `Stop` the assistant's last
message. The Worker reads eight fields and drops the rest without storing it, but it does cross
the wire, it isn't 200 bytes, and `http` hooks can't run in the background. `TASKS_TOKEN` and
`TASKS_MACHINE` also have to be exported wherever `claude` starts, since Claude Code sends no
host name. That's why the script is the default.

**The endpoint.** `POST /tasks/api/presence` with `Authorization: Bearer tasks_…` (a personal
access token; a cookie isn't accepted). The body is a hook payload; these fields are read and
nothing else: `session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input.file_path`,
`tool_input.description`, `message`, `notification_type`. `X-Tasks-Machine`, `X-Tasks-Agent`,
and `X-Tasks-Link` (an `https` link back to the session, shown instead of the resume command)
are optional. A bad token gets 401. Everything else gets `200 {}` so a hook can never fail or
slow a session; the `X-Tasks-Presence` response header says what happened (`stored`, `skipped`,
`ended`, `sealed`, `not-json`, `no-session`).

| Event | State | Last action |
|---|---|---|
| `SessionStart` | idle | session started |
| `UserPromptSubmit` | working | got a prompt |
| `PreToolUse`, `PostToolUse`, anything else | working | `Edit: server.ts` (at most one write per 30s while already working) |
| `PermissionRequest` | needs input, until the session's next event of any kind | wants to use Bash |
| `Notification` (`permission_prompt`, `idle_prompt`, `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input`, unknown types) | needs input | the notification's message |
| `Notification` (`auth_success`, `agent_completed`, `elicitation_complete`, `elicitation_response`, `quota_…`) | unchanged | the notification's message |
| `Stop` | idle | finished its turn |
| `SessionEnd` | row deleted | |
| `ask_ceo` over MCP, while the question is open | reads needs input, over whatever the rows above last wrote | asked: Limit by IP or by account? |
| You answer it, or the question is taken back | what the rows above last wrote | the same |

**A settled prompt clears.** `needs input` from a `PermissionRequest` or a `Notification` isn't
a state the session has to leave by a matching event: the next event of any kind replaces the
row, so `PostToolUse` puts it back to working and `Stop` to idle. Approved or denied, the
session moved on, and the row says so. The catch was the throttle. A tool event inside the
30-second window was dropped before it was sent, so a prompt you'd answered could sit at
"needs input · wants to use Monitor" for a minute with nothing waiting. Now any event that
isn't a tool event clears the script's stamp, and the first tool event after it is always
sent; the server's own throttle only ever applied to a row that already says working. A
denied tool fires no `PostToolUse` of its own, so the row clears on the session's next tool
call or at the end of its turn. Add a `PreToolUse` hook beside the others if you want it a
call sooner; the endpoint takes it as a tool event.

**Kept apart from the board.** Sessions and claims live in their own Durable Object, `Presence`
(`src/presence.ts`), one per user, in its own SQLite tables. Nothing goes through
`TodoAgent.mutate`, so a session reporting in never adds an undo step, flashes a card, reindexes
search, or publishes an agent event. The board tells `Presence` one thing, and nothing comes
back: which cards a change just finished or deleted, so their claims can end (Claiming cards,
below). The browser reads the list over its own WebSocket,
`/tasks/presence`, which takes the session cookie and refuses other origins like the board's.

**Claiming cards.** Several lead agents can work one board. Before starting a card, a lead calls
the MCP tool `claim_card` with the card's id and its session id: Claude Code's own when the
hooks have printed it into the session, otherwise the one `get_started` handed it
(`// CONNECT_AN_AGENT`). The `Presence` object handles one call at a time, so of two leads asking at once,
one gets the card and the other is told who has it. `get_board` ends with the list of claimed
cards, and `release_card` gives one back. A claim holds for 15 minutes after its session was
last heard from, which is longer than the 5-minute stale mark on purpose: a lead that's thinking
keeps its card, and one that died gives it up without anyone cleaning up. Any MCP call that
names a session counts as hearing from it: `claim_card`, `release_card`, `ask_ceo`, and
`wait_for_answer`, which also counts for whoever holds the cards it was given. So a lead with no
hooks installed can still hold cards, and one that's waiting on your answer keeps them. Claims aren't written
on the card, so they don't show up in undo, notes, or search.

**A finished card isn't claimed.** A claim says a session is working on the card, and nothing is
working on a card that's done or gone. So a claim ends the moment its card reaches the last lane
or is deleted, whoever did it: the agent over MCP (with or without `release_card`), you in the
app, or the assistant. The card stops saying "working" right then instead of 15 minutes later.
A `release_card` that arrives afterward finds nothing to release and says so, which is fine.

- **Where it happens.** `TodoAgent.mutate` (and undo and redo, which change the board without it)
  compares the board before and after with `endedCards` in `src/presence-shared.ts`. If a card
  ended, it calls `Presence.finish`, which drops the claim. That call is one-way and runs after
  the change is saved: no undo step, no flash, no agent event. A board with one lane has no done
  lane, so only a delete ends a claim there. An encrypted board keeps no presence and is skipped.
- **What counts.** Being in the last lane now and not before. That covers a move, a card added
  straight to the last lane, and a lane change that makes another lane the last one. A card
  moved back out of the last lane is just a card again.
- **Undo doesn't bring a claim back.** Undo the move and the card returns to its lane unclaimed.
  The agent claims it again if it's still on it; a claim the board invented would say a session
  is working when nobody has heard that from the session. Redoing the move, or undoing the
  "Add card" that made a claimed card, ends the claim like any other change does.
- **The session's row.** A session that reports through hooks keeps the row its hooks wrote.
  One that only claims gets a new last-action line, below.

**A session that asked.** A session with a question open is waiting on you, and both the card
and Sessions say so until you answer. How it works, and what was decided:

- **`ask_ceo` says who asked.** It takes an optional `session_id`. When the agent leaves it
  off, the asker is whoever holds the claim on the card, which is the agent itself when it
  claimed first, as the rules have it. So forgetting the id costs nothing. A named session
  that holds no claim gets one by asking, unless another live session has the card; then the
  question stands on the card with no session tied to it. `Presence.asked` in `src/presence.ts`.
- **The agent keeps its claim while it waits.** The rules used to say release, so another
  agent could take the card. But a card waiting on its owner isn't up for grabs (the rules
  already skip cards showing ASKING), and the held claim is what puts the session's line on
  the card. So the question lives on the claim (`asked` on `Claim`), not in a table of its own.
- **Needs input is read, not written.** The row underneath keeps whatever hooks or claims last
  wrote, like `working · mcp__tasks__wait_for_answer`. `Presence.view` runs the rows through
  `withAsks` (`src/presence-shared.ts`): a session whose claim carries a question reads
  `needs input` and `asked: <question>` (its newest, with several open). Hook events keep
  landing underneath and can't flip it back, and the moment the question closes the row is
  simply what was last stored. The demo and the front page's sample board build their rows
  with the same function.
- **Answering.** The board tells `Presence` which questions a change closed (`settledAsks`,
  next to `endedCards`): answered, or taken back by removing `#needs-ceo` or undoing the ask.
  The question comes off the claim and the claim stays. A hookless session's row goes back to
  working and says `got your answer on "<card>"`; a session with hooks shows what its hooks
  last wrote. Nobody was heard from, so last-seen doesn't move. Within about 2 seconds the
  agent's `wait_for_answer` returns, it claims again, and the row is its own from there.
- **A waiting agent never goes stale.** Each `wait_for_answer` call moves last-seen for the
  session it names and for the sessions holding the cards it names (`Presence.touch`), when
  the call starts and again when a hold ends unanswered. An agent 10 minutes into waiting was
  heard from at most 30 seconds ago.
- **When it gives up.** The rules stop the wait at 10 minutes. The agent stops calling, the row
  goes stale 5 minutes later (still under its question in "need you", marked stale), and
  after 15 quiet minutes the claim lapses and takes the question's tie with it: the card keeps
  its question and still counts once, with no session line. The next agent run takes
  ANSWERED cards first, so the answer isn't lost.
- **Undo doesn't bring the tie back.** Undo an answer and the question returns to the card;
  the session keeps its claim but no longer reads needs input, the same way a claim that
  ended stays ended. Nothing told the agent either.
- **Passed on:** leaving it to the agent to re-claim on a timer while it waits (it has no
  timer), a separate "waiting" state (needs input is what it is), and writing needs input into
  the stored row (the next hook event would overwrite it).

**A session that only speaks MCP.** An agent with no hooks is heard from through its MCP calls
alone, and `claim_card`, `release_card`, and `ask_ceo` write its whole row. `agent`, `machine`, and `project`
on `claim_card` are how it says who it is; passing them again on a later claim replaces what it
said before, and leaving them off keeps it. The card's session line reads the name from the
session's row, the same one Sessions shows, so a later `claim_card` without `agent` can't put
"agent" on the card while Sessions says "cursor". MCP can read the board, so the last-action line
names the card by its title.

| Call | State | Last action |
|---|---|---|
| `claim_card`, got the card | working | claimed "Fix the login redirect" |
| `claim_card`, refused | working if it holds another card, else idle | asked for "Fix the login redirect", which another session holds |
| `release_card`, holds another card | working | released "Fix the login redirect" |
| `release_card`, its last card | idle | released "Fix the login redirect" |
| `ask_ceo` on a card it holds | needs input while the question is open | asked: Limit by IP or by account? |
| You answered | working (it kept the card) | got your answer on "Fix the login redirect" |
| The question was taken back | working | its question on "Fix the login redirect" was taken back |
| `wait_for_answer` | unchanged; last-seen moves | unchanged |
| An agent moved the card to the last lane | idle, or working if it holds another card | finished "Fix the login redirect" |
| You or the assistant moved it there | same | "Fix the login redirect" was moved to Done |
| The card was deleted | same | "Fix the login redirect" was deleted |
| 15 quiet minutes, so its claims lapse | idle | its claim lapsed |

So such a session is "working" only while it holds a card. **Idle means finished, and isn't
counted as live.** With no hooks, nothing says the agent's process is still running, and an
idle MCP-only session holds no card and waits on nothing. So the Sessions button doesn't count
it (`isLive`): a one-shot agent that moved its card to Done and exited drops out of "N live
sessions" right then, not 5 minutes later, while its row stays in the list saying what it
finished. The rules' last step has the agent release anything it still holds, which is what
makes its row idle. An idle session with hooks still counts: its terminal is open. The test
for "MCP-only" is a row with no folder, since every hook report carries one. A refused claim counts as being heard
from and nothing more. Once a hook reports for a session, the event table above is in charge of
its row, and a claim or release only moves its last-seen time (and fills in the agent kind when
the hooks didn't send one). The rules are `afterClaim`, `afterRelease`, `endedCards`, and
`afterEnded`, `afterAsk`, `settledAsks`, `afterSettled`, `withAsks`, and `isLive` in
`src/presence-shared.ts`; `npm run check:presence` runs them, along with the "need you" count. The last three rows don't count as hearing from the session, so its last-seen
time stays put: the line says "finished" only when an agent made the move, since the board can't
tell which agent, and says what happened to the card when a person did.
What a hookless session can't say: that it's stopped at a terminal prompt, or that it's alive
between MCP calls, which is why the lead instructions below renew the claim. For a lead
agent's instructions:

```
Before you move a card to Doing, call claim_card with its id, your session id (the "Tasks
session id:" line in your context, or $CLAUDE_CODE_SESSION_ID), and
agent "lead". If it's refused, another lead has it: skip that card. Call claim_card again on the
card you're working at least every 10 minutes. When you ask Scott something with ask_ceo, pass
the same session id and keep the claim: the card shows you waiting on him. Call wait_for_answer
with the card's id while you wait. Moving a card to Done releases it for you; call release_card
only when you give a card up.
```

**Encrypted boards keep no presence.** It's metadata about sessions, not card text, so it could
have been allowed. It isn't, for three reasons. Someone who turned encryption on has said the
server shouldn't hold anything readable about their work, and project names, file names, and
"wants to use Bash" lines are readable descriptions of that work. Hooks have no key, so presence
can't be encrypted the way card text is. And claims need MCP, which is already closed on an
encrypted board. So reports to an encrypted board are dropped (`X-Tasks-Presence: sealed`), the
Sessions button is hidden, and turning encryption on erases the rows that were there.

## // SEARCH

Search covers card titles and notes (not attachments yet). It runs inside each user's
TodoAgent (`src/search.ts`), so results never cross between users.

- **Keyword:** an FTS5 table (`card_fts`) with porter stemming, prefix matches for terms
  of three or more letters, and bm25 ranking with titles weighted 5x. Common words are
  dropped.
- **Semantic:** one embedding per card from Workers AI (`EMBEDDING_MODEL`,
  `@cf/baai/bge-small-en-v1.5`), stored in `card_vec` and compared by cosine
  similarity. Boards are small, so a scan is faster than a vector database. Results
  must score at least 0.52 and be within 0.06 of the best match. Those numbers come from
  measured scores; tune them in `search.ts` if a new model behaves differently.
- **Hybrid** (the default) merges both rankings with reciprocal rank fusion.
- **Freshness:** every change updates the keyword index in the same step, undo
  included. Embeddings refresh in the background when a card's text changes, and any
  stale ones are refreshed before a semantic search. Moving cards costs nothing.
- **Surfaces:** the ⌘K search box, the assistant's `search_cards` tool, and the MCP
  `search_cards` tool. All three call `TodoAgent.search`.
- Without Workers AI (`npm run dev:local`), search falls back to keyword matches and
  says so.
- On an end-to-end encrypted board the server has nothing to index. The tables are emptied, and
  ⌘K searches the decrypted board in the tab instead (`src/client/localSearch.ts`, keyword only).

## // ATTACHMENTS

Cards take files: the Attach files button, dropping files on an open card, or pasting a
screenshot into it. The New card dialog takes them the same way and uploads them once the
card is added. `POST /tasks/api/attachments?card=<id>` streams the body into R2,
then tells the card's agent over RPC (`attach`, which the browser can't call). Only
name, size, and type go into the board, so agents and the assistant see file names.

- **Limits.** `ATTACHMENT_MAX_MB` (25) per file and `ATTACHMENT_QUOTA_MB` (250) per user,
  counted from R2. At most 20 files per card.
- **Downloads** (`GET /tasks/api/attachments/<id>`) only look under the signed-in user's
  own prefix. Images, PDFs, and plain text open inline; everything else downloads as
  `application/octet-stream`. Every response has `nosniff`, and everything but PDFs
  gets a sandboxing CSP, so an uploaded HTML or SVG file can't run on this origin.
- **Removal is undoable.** Removing a file, or deleting its card or lane, drops only the
  reference. `TodoAgent.collectAttachments` deletes R2 objects that neither the board
  nor undo history refers to. It runs 25 hours after something drops a file, and again
  weekly while history still holds removed ones. It skips objects under an hour old,
  in case an upload is still finishing.
- R2 costs: 10 GB and 1M writes a month are free, then $0.015/GB-month, and there are
  no download (egress) fees.

## // TURNSTILE

The email sign-in form carries an invisible Turnstile widget ("interaction-only":
it shows a checkbox only when Cloudflare wants one). `POST /api/auth/start` checks
the token with Siteverify before sending a code, and requires `success`, action
`signin`, and a hostname in `TURNSTILE_HOSTNAMES`. Tokens are single-use, so the
widget resets after every send. Google and Microsoft sign-in are redirects and
don't need it.

- Production: set `TURNSTILE_SITEKEY` in `wrangler.jsonc`, and the secret with
  `npx wrangler secret put TURNSTILE_SECRET`. An empty sitekey turns the check off.
- Dev: `.dev.vars.example` has Cloudflare's always-pass test keys. The server
  accepts test-key results only when `DEV_LOGIN_CODES=1`.

## // BILLING

Free accounts get `FREE_DAILY_CHATS` assistant messages a day; Pro raises it to
`PRO_DAILY_CHATS`. Upgrade from the chat (at the cap) or the user menu, which opens
Stripe Checkout. Pro users get "Manage subscription" (the Stripe Customer Portal)
for card changes and cancellation.

- **Truth lives in Stripe.** `POST /tasks/api/stripe/webhook` checks the signature,
  then fetches the subscription fresh from Stripe and stores its current state in
  D1, so late or out-of-order events can't leave a wrong plan. `active`, `trialing`,
  and `past_due` count as Pro. A period that ended over three days ago without a
  renewal event counts as lapsed, in case a webhook is missed.
- **The cap is checked in the agent** (`usage()` in `src/agent.ts`), which reads the
  plan from D1 on each message.
- Billing stays off until `STRIPE_PRICE_ID` (var) and the `STRIPE_SECRET_KEY` and
  `STRIPE_WEBHOOK_SECRET` secrets are all set.
- **Pricing is public and never hard-coded.** `GET /tasks/api/plans` needs no session and
  returns `{ free: { dailyChats }, pro: { dailyChats, price } | null }`. The caps are
  `FREE_DAILY_CHATS` and `PRO_DAILY_CHATS`; `price` is `{ amount, currency, interval,
  intervalCount }` read from Stripe for `STRIPE_PRICE_ID` (amount in the smallest unit) and
  kept in memory for an hour. With billing off `pro` is `null`, and the landing page shows
  Free only and says Pro isn't on sale yet. If Stripe can't be reached, or the price is tiered
  or one-time, `price` is `null` and the page says the price is shown at checkout. The key
  needs read access to Prices. Don't put a dollar amount in the client.

Setup:
1. In Stripe, create a product ("Tasks Pro") with a recurring price, and put its `price_…` id in
   `STRIPE_PRICE_ID`.
2. Settings → Billing → Customer portal: save a configuration (Stripe requires one
   before portal sessions work). Allow cancel and payment-method updates.
3. Developers → Webhooks → add endpoint `https://askscottpierce.com/tasks/api/stripe/webhook`
   with events `checkout.session.completed` and `customer.subscription.created`,
   `.updated`, `.deleted`, `.paused`, `.resumed`. Copy its signing secret.
4. `npx wrangler secret put STRIPE_SECRET_KEY` (a restricted key needs write access to
   Checkout Sessions and Customer Portal, and read access to Subscriptions and Prices), then
   `STRIPE_WEBHOOK_SECRET`.

Locally: `stripe listen --forward-to localhost:5173/tasks/api/stripe/webhook` prints a
`whsec_…` for `.dev.vars`. Pay with card `4242 4242 4242 4242`.

## // PRIVACY_AND_TERMS

`/tasks/privacy` and `/tasks/terms` (`src/client/Legal.tsx`) are public pages, linked
from the sign-in screen and from Google's consent screen. Keep the privacy policy in
step with what the app stores: update it when you add a table, a processor, or a cookie.

## // LINK_PREVIEWS_AND_TITLES

`index.html` carries what a shared link shows for the front page: the title, description,
canonical URL, `og:*` and `twitter:*` tags, and a JSON-LD `SoftwareApplication` block. Only put
true facts in there: no ratings, no user counts, and no price until billing is on.

**Every page gets its own head.** Link-preview fetchers (Slack, X, iMessage, Hacker News) read
the raw HTML and don't run JavaScript, and every page is the same `index.html`. So the Worker,
which answers every `/tasks` page itself, rewrites the head on the way out with `HTMLRewriter`
(`shell` and `withHead` in `src/server.ts`), from one table: `PAGE_META` in `src/routes.ts`.

| Address | `<title>`, `og:title`, `twitter:title` | Description | Canonical and `og:url` |
|---|---|---|---|
| `/tasks/` | the default title | as written in `index.html` | `https://askscottpierce.com/tasks/` |
| `/tasks/demo` | Demo board · Tasks | a live demo board, no sign-up | `…/tasks/demo` |
| `/tasks/connect` | Connect an agent · Tasks | from the table | `…/tasks/connect` |
| `/tasks/pricing` | Pricing · Tasks | from the table | `…/tasks/pricing` |
| `/tasks/privacy`, `/tasks/terms` | Privacy · Tasks, Terms · Tasks | from the table | their own address |
| anything else (404) | Not found · Tasks | "There's no page at this address." | removed, and `robots` is `noindex` |

- **To add a page or change a title**, edit `PAGE_META`. A row has a `name` and a
  `description`; the description is written to `meta description`, `og:description`, and
  `twitter:description` alike. The client's tab titles come from the same rows: `useTitle`
  only accepts a name that's in the table, so a title can't say one thing in the HTML and
  another in the tab.
- **The front page is the exception.** Its descriptions and JSON-LD stay written out in
  `index.html`, and the Worker only sets its title, from `DEFAULT_TITLE`. Every other page has
  the JSON-LD block removed: it describes the product, on the front page.
- **Canonical URLs always name production** (`SITE` in `src/routes.ts`), whatever host served
  the page, and have no trailing slash except `/tasks/`. `/tasks/demo/` says `/tasks/demo`.
- **`og:image` is the same picture everywhere.** A per-page image would need its own render.
- **`/tasks/pricing` is the front page opened at its pricing section**, with its own title and
  canonical so a shared pricing link previews as pricing.
- **Rewritten pages carry no `ETag`**: the file's ETag describes `index.html`, not the page
  made from it. The Worker never answered a page with a 304 anyway.
- It works the same under `vite dev` and from the built Worker. Check a page with
  `curl -s localhost:5173/tasks/demo | grep -iE '<title>|description|canonical|og:|twitter:'`.

- **The share image** is `public/tasks/og.png` (1200x630), and the home-screen icon is
  `public/tasks/apple-touch-icon.png` (180x180). Both are screenshots of HTML kept in
  `scripts/og/` (`og.html`, `icon.html`). To change one, edit the HTML, run `npm run og`, look
  at the PNG, and commit both. The script drives headless Chrome from
  `/Applications/Google Chrome.app`; set `CHROME=` to use another Chrome or Chromium. It needs
  a network connection for the Google Fonts, and fails if a PNG comes out the wrong size.
- **Static files go in `public/tasks/`**, so their path matches their URL and the asset layer
  serves them. A file anywhere else under `public/` isn't reachable on the `/tasks` routes,
  and a missing one gets the not-found page with a 404. After adding one, check
  `curl -sI localhost:5173/tasks/og.png` says `image/png`.
- X, Slack, and iMessage cache previews. After changing the image, rename it (and the URLs in
  `index.html`) if the old one has to stop showing.
- **Tab titles** come from `useTitle` in `src/client/title.ts`: `useTitle("Connect an agent")`
  gives "Connect an agent · Tasks". Each page calls it once at the top of its component, with a
  name from `PAGE_META` (or "Board", your own board's tab, which is never in served HTML). The
  sign-in screen calls it with no name and gets the full default title, because that's the
  page a shared link lands on. `DEFAULT_TITLE` in `src/routes.ts` is that title; `<title>` in
  `index.html` should say the same, and the Worker overwrites it with the constant either way.

## // SIGN_IN_WITH_GOOGLE_AND_MICROSOFT

The sign-in screen (and the OAuth consent flow) offers "Continue with Google" and
"Continue with Microsoft" next to the emailed code. Each button appears once both of
its secrets are set. Whichever way someone signs in, the verified email picks the
board, so one person gets the same board every time. `ALLOWED_EMAILS` still applies.

**Google** is set up in Cloud project `ask-scott-pierce` (Google Auth Platform: app
"Tasks", External, In production; client "Tasks web"). `GOOGLE_CLIENT_ID` is a var in
`wrangler.jsonc`; only `GOOGLE_CLIENT_SECRET` is a secret. To redo it elsewhere
(Google Cloud console → Google Auth Platform):
1. OAuth consent screen: External, scopes `openid`, `email`, `profile`. Publish it,
   or add test users while it's in testing.
2. Credentials → Create credentials → OAuth client ID → Web application.
3. Authorized redirect URIs: `https://askscottpierce.com/tasks/api/auth/sso/google/callback`
   (and `http://localhost:5173/tasks/api/auth/sso/google/callback` for dev).
4. `npx wrangler secret put GOOGLE_CLIENT_ID`, then `GOOGLE_CLIENT_SECRET`.

**Microsoft** (Outlook.com, Hotmail, Microsoft 365; Entra admin center → App registrations):
1. New registration. Supported account types: **Accounts in any organizational
   directory and personal Microsoft accounts**.
2. Redirect URI, platform Web: `https://askscottpierce.com/tasks/api/auth/sso/microsoft/callback`
   (add the localhost one for dev under Authentication).
3. Manifest → add `"optionalClaims": { "idToken": [ { "name": "email", "essential": false }, { "name": "xms_edov", "essential": false } ] }`
   and save. (`xms_edov` often isn't listed under Token configuration, so the manifest is the reliable way.)
   Work and school tenants can put any address in `email`, so the app only trusts it
   when `xms_edov` (the domain is verified) is true. Personal accounts are always trusted.
4. Certificates & secrets → New client secret.
5. `npx wrangler secret put MICROSOFT_CLIENT_ID` (the Application (client) ID), then
   `MICROSOFT_CLIENT_SECRET` (the secret's **Value**, not its ID).

Locally, put the same four values in `.dev.vars` (see `.dev.vars.example`).

Keys: `⌘K` search · `n` new card · `/` assistant · `t` theme · `⌘Z` undo · `⇧⌘Z` redo · `Space` pick up a
card, arrows to move it · `Enter` edit a card (then `Enter` or `e` on the notes to edit them) · `x` mark the focused card done (or reopen it). Pasting a list into "Add a card"
creates one card per line.

## // DEVELOP

```sh
npm install
npm run db:migrate:local
npm run dev          # http://localhost:5173/tasks/ — Workers AI is always remote, so `npx wrangler login` first
npm run dev:local    # no Cloudflare login needed; everything works except the assistant
npm run typecheck
npm run build && npx vite preview   # the built Worker, for checking status codes: /tasks/nope is a 404
npm run check:markdown   # the notes renderer: what renders, and that a hostile note can't run script
npm run check:sort       # lane sorting: each order, and that only the sorted lane moves
npm run check:events     # the agent feed: #agent and #gauntlet cards publish, nothing else does
npm run check:nudge      # "No agent connected yet": when it shows, and that undo can't bring it back
npm run check:setup      # the Sessions installer against a temp HOME: fresh, existing settings.json, run twice
npm run check:tags       # tags typed in a title: "Write a haiku #agent" is tagged, "Fix #123" and "C#" are left alone
npm run check:presence   # Sessions rules: what a claim, a refused claim, and a release say, and that one decision counts once
npm run og               # re-render the share image and home-screen icon from scripts/og/
npm run shots            # the Product Hunt gallery, shot from the running app (// LAUNCH)
npm run check:launch     # the launch copy against its limits, and the gallery's files and sizes
```

The `/tasks` base lives in nine places: `src/client/base.ts`, `src/server.ts`,
`src/mcp.ts` (`MCP_PATH`), `src/oauth.ts` (`AUTHORIZE_PATH`), `src/sso.ts` and
`src/auth.ts` (redirect and cookie paths), `src/agent-rules.ts` (the default `base`),
`vite.config.ts` (`build.assetsDir`), and `wrangler.jsonc` (`routes`, `run_worker_first`).

`.dev.vars` sets `DEV_LOGIN_CODES=1`, which skips sending email: the code shows
on the sign-in screen and in the terminal. Copy `.dev.vars.example` to create it.

## // ROUTING_BENCH

`bench/` checks whether a fast model can handle plain commands ("finished the taxes") without
a GLM round trip. There's no real traffic to mine, so `bench/cases.ts` holds three simulated
boards and 80 hand-labeled commands, traps included.

```sh
npm run bench                  # the GLM and Jev arms; starts a throwaway Worker (bench/wrangler.jsonc) on :8799
npm run bench -- --arm glm     # the production prompt and tools (src/prompt.ts, src/tools.ts)
npm run bench -- --arm jev     # embed the message, shortlist cards, one Jev call
npm run bench:needle           # the Needle arm: the real wasm engine in Node, ../needle-rs weights (NEEDLE_RS= to point elsewhere)
npm run bench -- --score       # re-score bench/results/*.jsonl without calling a model
```

The Needle arm is the one that ships: it runs the same `src/needle-tools.ts` the tab does and
reports, per threshold, how many commands the local path would take and how many it would get
wrong. On the 80 cases (2026-09-27), at the shipped threshold of 0.8 it takes 17 commands and
gets all 17 right; between 0.5 and 0.9 the count only moves between 19 and 16, always with zero
wrong actions. The rest, including every question, every two-clause message, and the traps, go
to GLM. In Node's single-threaded exact build a turn is about a second; in the browser's relaxed
build it measured about 250 ms.

- Jev is a third-party model, so it runs through AI Gateway (Unified Billing). The
  `wrangler login` token has no AI Gateway scope, so local runs of the Jev arm need
  `CLOUDFLARE_API_TOKEN` set to a token with AI Gateway Run, Workers AI Read/Write, and
  Workers Scripts Write (`wrangler dev`'s remote preview needs the last one). A new
  permission can take a minute or two to reach `wrangler dev`.
- Unified Billing only spends credits through a gateway with Authentication turned on.
  With it off, every non-`@cf/` model fails with `2049: Invalid User Credentials`, even
  with credits loaded.
- Through Unified Billing the Jev response is wrapped as `{ state, result: { answers, usage } }`,
  and a noul answer reads `{ type: "noul", noul: 0.96 }`.
- Latencies go through `wrangler dev`'s remote-binding proxy, which adds overhead to
  every model call. GLM makes several calls per command, so it pays that overhead more often.

## // VERSION_AND_CHANGELOG

The footer on every page ends with the running version, like `$ v0.1.0 · 7270832`: the release
in `package.json` and the short git commit the build came from. Before the first release it shows
the commit and the build day instead. Clicking it opens `// WHATS_NEW`, the newest entries of
`CHANGELOG.md`, with a link to the whole file.

- `CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic
  versioning. **Add a line under `[Unreleased]` with every change someone would notice**, in the
  right group (Added, Changed, Fixed, Security), at the end of the group, in plain words for
  the person using the app. Backticks render as code; nothing else is formatted.
- `vite.config.ts` reads the version, the commit, and the changelog when the build starts and
  bakes them in as `__BUILD__` (`src/client/Footer.tsx` reads it). Nothing is fetched at run
  time. The footer shows the newest two releases with entries, 14 lines at most, newest first
  within each group. `__BUILD__.counts` is how many entries the changelog holds (all of them,
  the ones under `[Unreleased]`, and the newest release's), which the landing page quotes.
- A `+` after the commit means the build had uncommitted changes, so the commit doesn't fully
  say what's running. A deploy from a clean `main` never has one.
- Cutting a release: `[Unreleased]` becomes `[X.Y.Z] - YYYY-MM-DD` with a fresh empty
  `[Unreleased]` above it, `version` in `package.json` is set to match, and the commit is tagged
  `vX.Y.Z`.
- To check a deploy landed, compare the footer with `git rev-parse --short HEAD`.

## // LAUNCH

`docs/launch/` is the Product Hunt kit. Nothing in it deploys or posts anything.

- `product-hunt.md`: the form's fields, the maker's first comment, ready answers, and the shorter
  pitches for X, LinkedIn, and Hacker News. Limits and where they came from are at the top.
- `checklist.md`: what to do before, on, and after launch day, in order.
- `video.md`: a shot list for a short demo video.
- `gallery/`: six gallery images and the 240x240 thumbnail.

```sh
npm run shots                                  # make the gallery from http://localhost:5190
npm run shots -- http://localhost:5173 --only 03,06   # just some of them; `thumb` is the thumbnail
npm run shots -- https://askscottpierce.com --only 01,02,03,04,06,thumb   # from the live site (not 05)
npm run check:launch                           # count the copy against its limits, and check the gallery
```

Each image is one idea: a crop of the real app set on a 1270x760 dark canvas with a
`// KICKER`, a headline, and usually a line under it, saved at 2x. In order: the board with an
agent's question on a card, the "need you" list, the Sessions list, an open card, the four-step
quick start, and the "need you" list on a phone. The canvas is HTML in `scripts/shots.mjs`
(`canvas()`), so a headline is changed there and the gallery is shot again. A headline says
"one tap" only over the "need you" list, because a card on the board takes two taps on a touch
screen (`// QUESTIONS`).

`scripts/shots.mjs` drives the Chrome in `/Applications` over the DevTools protocol (`CHROME=` to
use another), headless and with a throwaway profile, so there's no dependency to install and it
never touches the Chrome you're signed in to. How the crops are made:

- A list or a dialog is cropped to its own edges, with everything else on the page hidden for the
  shot, so no sliver of the board shows around it.
- A crop that's taller than the canvas runs off the bottom edge, and the cut is put in the gap
  between two rows (the open card's notes, the quick start's blocks), never through one.
- `05` is the only signed-in picture. The script signs up through the landing page's form with a
  made-up `shots-…@example.com` address and the code a dev server shows on screen
  (`DEV_LOGIN_CODES=1`), adds the sample card, copies the command, and presses Show the steps,
  since the block folds after a copy. So `05` comes from a dev
  server only; against the live site it fails and says so. It finds the quick start by structure
  (the section labelled by its heading, an ordered list of four steps, the buttons in steps 2
  and 3, the command in a `role="status"` block), not by wording. The token in the command is
  dotted out and the local address is swapped for the hosted one. It's drawn at 1.25x when the
  command fits above the canvas's bottom edge at that size; when the steps' wording runs
  longer, the script widens the page and steps the zoom down (to 1x at the least) until it does.

Each shot waits for the thing it's a picture of and fails with the reason when it isn't there,
or when the canvas wouldn't fit (a headline too wide, a list too tall), so a change to the demo
or a page that breaks a shot shows up as a failed run. Two runs against the same build give the
same bytes. The canvas's fonts come from Google Fonts, so it needs the network. Look at the PNGs
after every run.

The copy's limits are checked from the `<!-- count: … -->` comment above each block
(`scripts/check-launch.mjs`). The same check fails when a gallery image named in `product-hunt.md`
is missing, isn't 2540x1520 or 1270x760, or is 3 MB or more, and when `gallery/` holds a picture
the copy doesn't name. Every claim in the copy has to be true of the app as built; when a
feature changes, check `docs/launch/` the same way you'd check the landing page.

## // DEPLOY

```sh
npm run deploy               # vite build && wrangler deploy
npm run db:migrate:remote    # only when migrations/ changes
```

Secrets (`npx wrangler secret put <NAME>`): `TURNSTILE_SECRET`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `GOOGLE_CLIENT_SECRET`, and optionally `MICROSOFT_CLIENT_ID` and
`MICROSOFT_CLIENT_SECRET`. (`GOOGLE_CLIENT_ID` is a var in `wrangler.jsonc`.)

`OAUTH_KV` is the `todo-agent-oauth-kv` namespace, created by the first OAuth deploy
and pinned by id in `wrangler.jsonc`. The R2 bucket for attachments is created the
same way by the first deploy that includes them; pin its `bucket_name` afterwards.

The D1 database (`616a0109-…`) exists, and askscottpierce.com is already set up
for Email Sending.

## // CONFIG (`wrangler.jsonc` vars)

| var | default | |
|---|---|---|
| `CHAT_MODEL` | `@cf/zai-org/glm-4.7-flash` | any Workers AI model with function calling |
| `EMAIL_FROM` | `hey@askscottpierce.com` | must be on a domain onboarded to Email Sending |
| `ALLOWED_EMAILS` | empty (anyone) | comma-separated emails or `@domain.com` rules to make it invite-only |
| `DEV_LOGIN_CODES` | unset | `1` in `.dev.vars` only. Never set it in production. |
| `TURNSTILE_SITEKEY` | empty (off) | public sitekey for the sign-in widget |
| `TURNSTILE_HOSTNAMES` | `askscottpierce.com` | hostnames Siteverify may report; never `localhost` in production |
| `FREE_DAILY_CHATS` | `30` | assistant messages per day on the free plan |
| `PRO_DAILY_CHATS` | `150` | assistant messages per day on Pro |
| `STRIPE_PRICE_ID` | empty (billing off) | the Pro subscription's recurring price |
| `ATTACHMENT_MAX_MB` | `25` | largest single attachment |
| `ATTACHMENT_QUOTA_MB` | `250` | attachment storage per user |
