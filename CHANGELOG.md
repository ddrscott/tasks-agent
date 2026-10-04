# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- The footer shows the running version; click it for the latest changes
- Sort a lane from its menu by due date, title, newest, oldest, or recently updated. The lane remembers it: it stays sorted as cards come and go, after a reload, and in any browser you sign in from
- Attach files while creating a card — they upload as soon as the card is added
- The Tags field suggests tags you've already used; tap one to add it
- Agents can read a card in full over MCP with `get_card`: all of the notes, plus attached screenshots and small text files
- An empty board shows `// START_HERE`, four steps that end with Claude Code working a card: sign in, Add a sample agent card, Copy the command, paste it in a terminal
- Add a sample agent card puts a real `#agent` card on the board. It has the agent read the folder you start it in, ask you which of a few small improvements to plan, write that plan on the card as a checklist, and move the card to Done. It only reads, so the terminal has nothing to approve. One undo removes it
- Copy the command gives one line that connects Claude Code to your board with a new access token and starts it on your `#agent` cards, with no Authenticate and Allow step. It pre-approves the board's tools, deleting cards included, and not file writes or shell commands, and the page says so. The Connect page has the same quick start at the top, and a one-line command for Codex
- Agents can call `get_started` over MCP to read the rules for working the board. The rules have an agent say what it is, its machine, and its folder when it claims a card, keep your `ANSWER:` lines when it updates its status, and ask you on the card when it's stuck instead of stopping quietly. It hands the agent a session id to claim with, so nothing needs a shell
- Agents wait for your answer with `wait_for_answer` over MCP: it holds until you answer and hands the card back, in any MCP client. Delete the card or move it to the last lane instead, and the agent is told to stop waiting on it
- A card shows its agent's `STATUS:` line on its face, so you can see what it's doing without opening it
- With the Sessions hooks installed, a Claude Code session is told its session id when it starts, so the cards it claims show under the same row as the session
- The Connect page has a Sessions section with the Claude Code hooks to copy and the hook script to download, and a section on working with an agent: the `#agent` tag, questions, claims, and the event feed
- On a phone or tablet, an open card has a Move to row: tap a lane and the card moves there
- A card an agent session is working on shows that session in the card: its state, machine, last action, and a Copy resume command button
- With a tag filter on, each lane's count shows matches out of the total, like `2 / 22`
- Menus and popovers work from the keyboard: opening one puts you inside it, Esc puts you back on its button, and the arrow keys move through the account and lane menus
- Tag a card `#gauntlet` to have an agent build and critique it round after round overnight without asking; `tasks-gauntlet` starts one per repo
- `tasks-events --require <tag>` — hear only cards that carry that tag too, so a lead and a gauntlet agent can share a repo
- A link to Tasks shared in Slack, iMessage, X, or anywhere else that previews links shows a title, a description, and a picture of the board. Each page previews as itself: a link to `/tasks/demo` says it's a live demo board with no sign-up, and Connect, Pricing, Privacy, and Terms show their own titles and descriptions
- Each page names itself in the browser tab, like `Connect an agent · Tasks`, and Tasks has a home-screen icon on iPhone and iPad
- Signed out, `/tasks/` is a real front page: what Tasks is, the sign-in form, and a sample board showing an agent's question, a claimed card, and the Sessions list. Below that: what's different, including how an answer reaches your agent and that an encrypted board is closed to outside agents, the four-step quick start with the OAuth `claude mcp add` command under it, and a link to the demo board. On a phone the headline, the demo button, and a piece of the sample board come before the sign-in form
- Pricing is on the front page, readable before you sign up: the daily assistant limits for Free and Pro, and the Pro price as Stripe has it
- A mistyped address like `/tasks/nope` answers 404 Not Found and shows a not-found page with links to the pages that exist, instead of the sign-in form
- Until your first agent connects, the board says "No agent connected yet" above the lanes, and each `#agent` card says nothing will pick it up, with a link to Connect. With no `#agent` card yet, it says how to hand one over: add `#agent` to a card's title, or use the Tags field. It all goes away the moment an agent connects
- A demo board at `/tasks/demo` you can try without signing up: drag cards, answer an agent's question, and watch a scripted agent pick it up. It lives in your browser tab and nothing is saved
- The Connect page has a one-line starter prompt to copy into a newly connected agent, so it works `#agent` cards the right way from the first message
- One command sets up Sessions on a machine: it saves your token, installs the two scripts, and adds the hooks to `~/.claude/settings.json` without touching what's already there. It saves a backup of that file first and prints where it put it. The Connect page shows it with a new token filled in
- End a new card's title with `#agent` and it's tagged: "Write a haiku #agent" adds the card "Write a haiku" with the tag. Works in quick add, on each line of a pasted list, and in the new-card dialog, with several tags too. `#123`, `C#`, and a `#tag` in the middle of a title are left as typed
- The front page has `// CHECK_IT_YOURSELF`: links to the public code, the changelog with how many changes it holds, the encryption format, what Sessions stores, and who makes Tasks and why
- `/tasks/pricing` opens the front page at its pricing section, signed in or not

### Changed
- The Connect page opens on Claude Code and leads with coding agents: Claude Code, Cursor, and Codex come first, with Claude, ChatGPT, and Glean still there
- The + on a lane opens a full new-card dialog with notes, due date, and tags; "Add a card" at the bottom is still the quick way
- On a phone, the card dialogs fill the screen and stay above the keyboard, so Tags and the buttons are always reachable
- Bigger buttons on touch screens, and Theme moves into the account menu on a phone
- Long card titles wrap in the card dialogs instead of scrolling out of view
- The card editor saves only when you hit Save. The X in the top corner (or Esc) closes it without saving, and asks "Discard changes?" first if you edited something
- On a touch screen, answering an agent's question from the card on the board takes two taps: the first shows "Send: …?", the second sends it. The questions list and the open card are still one tap
- The agent's recommended answer on a card is marked `REC`, not only outlined
- Clear all cards and Delete lane take two taps: the first changes the item to say what the second will do
- After something is removed, the toast says how many and stays 10 seconds, so there's time to hit Undo
- "Connect an agent" is the first item in the account menu, and the Sessions list links to the hook setup
- When the top bar runs short on room, search shrinks to its icon, then the buttons drop to icon plus count, then the summary goes. On a phone the tag filter chip sits on its own row
- Orange and gray text is darker in the light themes, and the count badges use dark ink, so small text is easier to read
- Opening a card puts the cursor in the title. On a phone it leaves the keyboard down until you tap a field
- The assistant's footer says where it runs instead of naming models
- The Connect page opens without signing in, so you can read the setup steps before you make an account
- Over MCP, the board listing says when a card's notes are cut short, and changes answer with lane counts and the new cards' ids instead of the whole board
- The assistant's starter suggestions are about agent work: queue up cards tagged `agent`, ask what's waiting on your answer, ask which `#agent` cards aren't done
- A new, empty board opens with the Assistant panel closed, so `// START_HERE` and the lanes get the whole screen. Open it with the Assistant button or `/`. If you've opened or closed it before, or your board has cards, it opens the way it did
- "Need you" in the top bar is the one count of what's waiting on you. It adds sessions stopped at a permission prompt to the open questions and lists both, each session with its project, what it wants, its machine, and Copy resume command. The Sessions button just counts live sessions

### Fixed
- An agent with no Claude Code hooks (Cursor, Codex, anything on MCP) reads true in the Sessions list: it's working only while it holds a card, releasing a card says `released "<card title>"` and goes idle, and a claim that was refused no longer says it claimed the card
- Passing `agent`, `machine`, or `project` to `claim_card` again updates the session's row
- A card moved to the last lane, or deleted, stops saying an agent is working on it right away, whether the agent, you, or the assistant moved it. Before, it read "working" for up to 15 minutes unless the agent called `release_card`. In the Sessions list an agent without hooks goes idle and says `finished "<card title>"`
- A session's last action names the card by its title instead of its id
- A session with no project is listed under "No project" and a machine it didn't name is left off, instead of the word "unknown" twice. A session with no folder no longer offers a resume command
- "Need you" counts one decision once: a session stopped on a card that has an open question shows under that question instead of adding to the count
- Tapping the search icon on a phone opens search
- iPhones no longer zoom in when you tap a field
- The "Add card" label in quick add was unreadable against its button
- Dragging a card to the edge of a phone screen brings in one lane at a time. It used to race to the last lane and drop the card in Done
- The account button no longer slides off screen when agents have questions open or sessions are reporting in
- Muted text in Solarized, Sakura, Ocean, and Nord was too faint to read comfortably
- Screen readers announce every button by name. The account button used to be read out as your email address
- The Connect page's tool list was missing `get_card` and didn't say `update_card` can set tags
- On a phone, the Undo toast no longer lands on top of an open quick add
- Two changes a few milliseconds apart could leave the board showing the older one until the next change
- With the assistant open and more lanes than fit, the board no longer sits scrolled a little sideways with the first lane tight against the left edge
- "Add a card" in an empty lane opens right under the lane's name instead of leaving a blank gap above the box
- A long conversation with the assistant scrolls inside the panel instead of pushing the message box off the bottom of the screen
- Opening Tasks signed out no longer leaves an error in the browser console

## [0.1.0] - 2026-10-03

### Added
- Kanban board at askscottpierce.com/tasks with live sync across tabs, undo and redo, themes, and attachments
- Assistant in the sidebar — say "finished the dentist thing" and the cards move
- Needle 3 runs plain commands in the browser tab for free; GLM on Workers AI handles the rest
- Sign-in with an emailed code, Google, or Microsoft, with Turnstile on the email form
- Pro plan through Stripe, raising the daily assistant cap
- MCP server so Claude, ChatGPT, Cursor, Codex, and other agents can work the board, over OAuth or a personal access token
- Hybrid keyword and semantic search across titles and notes (⌘K)
- End-to-end encryption with a passphrase — the server keeps only ciphertext, built on JWE so a backup opens with any JOSE library
- Tags on cards — click one to fade out the rest; agents filter by tag over MCP
- Live event feed for agent sessions on your own machine — your changes to `#agent` cards wake the agent in seconds, with no tunnel or open port
- `tasks-events --tag <project>` — run one lead agent per repo, each hearing only its own cards
- Card notes render as markdown and switch to plain text to edit; checkboxes toggle in place
- // SESSIONS panel — every Claude Code session reporting in, grouped by project, needs-you first, stale after five quiet minutes
- Card claims over MCP, so two agents never take the same card, with the claiming session shown on the card
- One-tap answers — an agent asks a multiple-choice question and the card shows a button per option

### Changed
- Card notes grow to fit, and the card editor stays within the viewport
- Card editor fields use full-contrast text instead of the label's gray, so entered values no longer look like placeholders

### Fixed
- `tasks-events` hung silently on a bad token — it now retries and prints one `offline` line
- Session `Stop` events were lost when `claude -p` exited right after them

### Security
- Sign-in codes are single-use, with guess budgets per email and per IP across resends
- Encrypted boards refuse plaintext from every path — chat, uploads, MCP, and stale tabs — and turning encryption off or changing the passphrase needs a key proof
- Cookie-bearing requests from other origins are refused, including sibling subdomains

[Unreleased]: https://github.com/ddrscott/tasks-agent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ddrscott/tasks-agent/releases/tag/v0.1.0
