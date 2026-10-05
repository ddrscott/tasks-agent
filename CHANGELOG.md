# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- The lane menu has `This lane is`: To do, Doing, Done. Tap one to make that lane the one new cards land in, the one work in progress sits in, or the one that means finished
- Agents see which lanes are the to do, doing, and done lanes in `get_board`
- The server side of team boards: a Pro owner can invite people to their board by email as a viewer or a writer, with a single-use link that expires in 7 days, and can revoke, resend, change a role, or remove someone
- A card remembers who last changed it: you, a member, the assistant on someone's behalf, or an agent
- An audit log of invites, role changes, removals, people leaving, and deleted cards, with who and when, that the owner can download as CSV or JSON. The CSV opens cleanly in Excel, accented and non-Latin titles included
- Members, in the account menu: invite someone by email as a viewer or a writer, see who's on your board and since when, to the minute, change a role in place, and remove someone with two taps. Pending invites show when they were sent and when they expire, with Resend and Revoke
- Members shows how many of the board's 10 places are taken and how many invite emails you have left today, and says why when it can't invite: a free plan (with Upgrade to Pro right at the Invite button), a full board, a spent day of invites (both, when it's both), or an address that's already there
- When Pro lapses, Members says so: everyone's still listed, they can only look until Pro is back, and nothing was deleted. The button in the top bar reads "Sharing paused" and opens Members at the reason, and the assistant's plan label stops saying Pro
- The audit log is a tab in Members, newest first, with each time in your time zone and in UTC, a filter by person and by kind (membership or deleted cards), and Download CSV and Download JSON buttons. Downloads number the entries from 1 with no gaps and give every time in ISO 8601 UTC
- A shared board says "Shared with 2" in the top bar. Click it to open Members. The count and an open Members dialog follow within a second when someone accepts, leaves, or is removed, or when the plan changes
- The Encryption dialog says up front when a board can't be encrypted because it's shared, with a button to Members, and Members says when a board can't be shared because it's encrypted
- An invite link opens a page that shows who invited you, the role, and what that role can do, with Accept and Decline. It only works signed in as the address it was sent to, and it brings you back to the invite after you sign in. Open it again after you've accepted and it says you're already on the board, with a button to open it
- A board switcher next to the logo, once someone has shared a board with you: your board, and each shared one with your role. The open board is in the address, so a reload or a bookmark comes back to it
- A shared board says whose it is and what you can do on it. A viewer can read everything and change nothing; a writer can change cards, and lanes, undo, questions, agent cards, and board settings stay with the owner
- Leave a shared board from the account menu
- A shared board shows who last changed each card, and whether an agent or the assistant did it for them
- When the owner changes your role, removes you, or their Pro plan lapses or comes back, the board you have open changes right then and says what happened (a plan change within a second of the payment system telling us, and within about half a minute at worst). A removed member's tabs are closed within a moment, every one of them
- When someone deletes a card on a shared board, everyone else with it open sees who did and what it was called, and the owner's message has Undo. Several in a row from one person read as one message, and its Undo brings back all of them or none. The deletion goes in the audit log with the card's title and the lane it was in
- When your own agent deletes a card over MCP, your open board says so, with Undo
- The pricing section and the terms say what Pro buys: team boards, how many people a board holds, that members join free, what happens if Pro ends, who owns the cards, and that a viewer can copy what they can read. Members has the same answers under `// HOW_SHARING_WORKS`
- A shared board holds up under a member's script: changes and requests sent faster than a person could are told to slow down, a member can't grow someone's board past 1,000 cards or 768 KB, big changes count for more against that pace than small ones, text that isn't text (control characters) is refused, and a burst of changes reaches everyone else's tab a few times a second instead of once per change
- On a shared board your agents take orders from you alone. The tags that direct them (`#agent`, `#gauntlet`, `#needs-ceo`, `#ship-ok`) are the owner's: a member can't put one on a card or take one off, and a card tagged `#agent` or `#gauntlet` is read only to members and says so. A member who types one gets the reason, with what they typed still in the box
- Every line on the agent event feed says who made the change (`by`), and only the owner's changes are ever sent. Over MCP, `get_card` and `get_board` say when a card was last changed by a member, and the working rules tell agents that only the owner gives them work or answers
- Admins get an Admin page from the account menu: every account, with a switch to make someone an admin and a switch to give them Pro without a subscription. An email that hasn't signed in yet can be added ahead of time
- Pro given by an admin counts for team boards like a paid plan: that owner can invite people, and if an admin takes it back, members can only look from that moment, on the boards they have open, until Pro returns
- On a shared board a member can't use a tag that only looks like one of yours either: `ship_ok`, `agent-`, or `agent` spelled with a look-alike letter from another alphabet is refused, and so is a title that ends in one behind a full stop or an invisible character
- A card a member wrote keeps saying so after you move it, tag it, or answer a question on it. Agents see it in `get_card`, `get_board`, and on the event feed (`member`), and you see "words by" on the card
- When someone leaves your board, your open board says who
- Every file on a shared board records who uploaded it. A file a member attached says "attached by" them under its name, and your agents are told it's a member's file, not yours, right where `get_card` shows the file's name and what's in it
- "These words are mine now", in the card editor on your own board: the one way a member's mark comes off a card. The editor says what the mark does, next to the button

### Changed
- What's new fills the screen on a phone, and has an X in the corner to close it
- A card's notes box starts smaller and grows with what you type up to a limit, so the lane, due date, tags, and files under it stay in view. The expand icon next to Notes gives the notes the whole dialog, and shrinks them back
- To do, Doing, and Done are special because of what they are, not where they sit. Drag the lanes into any order, or rename them, and Done is still done: its cards stay struck through and out of the open count, Mark done still sends a card there, and agents' claims end there. Before, whichever lane was last counted as done
- A lane added at the end no longer becomes the done lane, and deleting the done lane no longer turns the lane next to it into one
- The working rules tell agents to put the card's id and the reason for a change in the git commit, so the repo explains itself if the card is later edited or deleted
- A list pasted into Add a card goes in as one change, so one Undo takes it back out. If some lines can't be added (a shared board that's full, say), those lines stay in the box and it says how many were added, how many are left, and why
- A malformed request to a shared board is refused with a plain sentence and stores nothing. Tags sent as one piece of text used to be saved a letter at a time
- On a shared board a member can't drag one of your `#agent` or `#gauntlet` cards up or down inside its lane. Moving it to another lane was already refused
- When an admin gives or takes back Pro, your audit log names the admin who did it instead of saying "system". Changes that come from billing still say system
- Manage subscription only shows when there's a subscription to manage. With Pro an admin gave and took back, Members offered it and it answered "No subscription to manage yet"
- When your plan changes while your board is open (Pro bought, lapsed, or given or taken back by an admin), the account menu and the assistant's limit follow right away, without a reload
- A viewer on a board whose owner's Pro plan lapsed is told the plan lapsed, instead of being told to ask for a writer role that wouldn't help
- Section labels inside menus (the board switcher, the account menu on a shared board, the lane menu) look like the app's other section headers
- When a pasted list leaves lines behind for different reasons, it gives each reason with the line it's about, not only the first one
- On a shared board, a writer editing a card with an open question sees `#needs-ceo` locked under the Tags field, with the reason, instead of finding out on Save that they can't remove it
- If a card you're editing on a shared board turns read only under you (you were made a viewer, the owner's plan lapsed, or the owner tagged it for an agent), what you typed stays on screen to copy, with a note that it wasn't saved. It used to vanish
- In the audit log, a run of deleted cards by one person (clearing a lane, say) shows as one line you can open, like "Deleted 733 cards", so invites and role changes aren't buried. The downloads still list every card
- A card a member wrote on stays marked however you edit it. The mark used to come off when an edit looked like a rewrite, which a one-letter fix to the title could set off and a full rewrite of the notes could miss. Now only "These words are mine now" takes it off
- Tags a member puts on your card, or takes off it, are marked as theirs too, on the card and everywhere your agents read it
- `search_cards` and `claim_card` say when a member wrote on a card, tagged it, or attached a file to it, the same as `get_board`
- Your audit log names an admin on a plan change only when that admin's own Pro switch caused it. A subscription that lapsed moments after an admin edited your account used to be put down to that admin
- If you're made a viewer while typing in the New card dialog or a lane's Add a card box, what you typed stays on screen to copy, marked "Not saved." If you're removed from the board, your own board opens with what you'd been typing there
- The privacy page says your audit log shows the email of a site admin who gave or took back your Pro plan, and what a shared board keeps about who wrote, tagged, or attached what
- A writer who deletes a card is told that only the board's owner can bring it back
- On a shared board a member can't use more tags that only look like yours: a digit for a letter (`ag3nt`, `ship-0k`), an odd Latin letter, or Cherokee or Lisu letters drawn like Latin ones. A member's title can't hold `#agent` anywhere in it, not only at the end
- Text nobody can see is taken out of what a member writes on your board: zero-width characters, direction overrides, and hidden tag characters, in titles, notes, tags, and file names. A title of nothing else is refused instead of making a blank card
- After a pasted list leaves lines behind, the button reads "Try these 3 again" instead of "Add 3 cards", and the box shows every line that's left, from the top
- At the member cap or the daily invite cap, the email field and the role choice are off along with the Invite button, and the field says why. The passphrase fields in the Encryption dialog are off the same way on a shared board
- Changing a member's role while your Pro plan is lapsed says they stay view only until it's back, instead of "It took effect right away"
- "These words are mine now" goes by the words you read. If a member changes the card's title, notes, or tags before your click lands, even a moment before, nothing is marked as yours and the card says it changed. Press again once you've read what it says now
- If someone changes a card while you have it open on your own board, the card says who, and shows what it says now. Fields you haven't typed in take the new words, and anything you were typing stays put
- `get_card` hands your agents each file's text between a begin line and an end line that carry a code made for that one answer, so a member's file can't pose as one of yours or as the board. Notes a member wrote are fenced the same way
- `get_card` says so when a file it lists isn't shown (a PDF, a text file over 32 KB, an image that's too big), instead of skipping it without a word

### Fixed
- Turning encryption on and back off no longer takes "written by a member" off cards, or "attached by" off files. The marks stay through both, and the privacy page says that record stays readable on an encrypted board

## [0.2.0] - 2026-10-04

### Added
- The footer shows the running version; click it for the latest changes
- Sort a lane from its menu by due date, title, newest, oldest, or recently updated. The lane remembers it: it stays sorted as cards come and go, after a reload, and in any browser you sign in from
- Attach files while creating a card — they upload as soon as the card is added
- The Tags field suggests tags you've already used; tap one to add it
- Agents can read a card in full over MCP with `get_card`: all of the notes, plus attached screenshots and small text files
- An empty board shows `// START_HERE`, four steps that end with Claude Code working a card: sign in, Add a sample agent card, Copy the command, paste it in a terminal. Once the command is copied the steps fold down to one line, so the lanes and the sample card stay in view while you wait for the agent's question; Show the steps opens them again
- Add a sample agent card puts a real `#agent` card on the board. It has the agent read the folder you start it in, ask you which of a few small improvements to plan, write that plan on the card as a checklist, and move the card to Done. It only reads, so the terminal has nothing to approve. One undo removes it
- Copy the command gives one line that connects Claude Code to your board with a new access token and starts it on your `#agent` cards, with no Authenticate and Allow step. It pre-approves the board's tools, deleting cards included, and not file writes or shell commands, and the page says so. It also says the token ends up in your shell history and where to revoke it. The Connect page has the same quick start at the top, and a one-line command for Codex
- Agents can call `get_started` over MCP to read the rules for working the board. The rules have an agent say what it is, its machine, and its folder when it claims a card, keep your `ANSWER:` lines when it updates its status, and ask you on the card when it's stuck instead of stopping quietly. A stuck agent recommends an answer you can give from the board, like doing it another way with the tools it has or skipping the card, not one that needs you back at the terminal. It hands the agent a session id to claim with, so nothing needs a shell
- Agents wait for your answer with `wait_for_answer` over MCP: it holds until you answer and hands the card back, in any MCP client. Delete the card or move it to the last lane instead, and the agent is told to stop waiting on it. An agent that's waiting keeps its card and never reads stale: every wait counts as hearing from it
- An agent that asked you a question reads `needs input` with `asked: <the question>` until you answer, on its card and in the Sessions list, with or without the Claude Code hooks. The "need you" list shows it under its question: agent, machine, project, and how long it's been waiting. Answer, and it's back to working on the card it kept
- A card shows its agent's `STATUS:` line on its face, so you can see what it's doing without opening it. A date at the front of that line is left off the face, so the room goes to the news; the notes keep it. Right after you answer a question the face says `answered: <your answer>` until the agent writes a new status, instead of an old line that still says it's waiting on you
- With the Sessions hooks installed, a Claude Code session is told its session id when it starts, so the cards it claims show under the same row as the session
- The Connect page has a Sessions section with the Claude Code hooks to copy and the hook script to download, and a section on working with an agent: the `#agent` tag, questions, claims, and the event feed
- On a phone or tablet, an open card has a Move to row: tap a lane and the card moves there
- A card an agent session is working on shows that session in the card: its state, machine, last action, and a Copy resume command button
- With a tag filter on, each lane's count shows matches out of the total, like `2 / 22`
- Menus and popovers work from the keyboard: opening one puts you inside it, Esc puts you back on its button, and the arrow keys move through the account and lane menus
- Closing a card puts keyboard focus back on that card, and closing New card puts it back on the lane's +. Screen readers hear both as dialogs, and the card's by its title
- Tag a card `#gauntlet` to have an agent build and critique it round after round overnight without asking; `tasks-gauntlet` starts one per repo
- `tasks-events --require <tag>` — hear only cards that carry that tag too, so a lead and a gauntlet agent can share a repo
- A link to Tasks shared in Slack, iMessage, X, or anywhere else that previews links shows a title, a description, and a picture of the board. Each page previews as itself: a link to `/tasks/demo` says it's a live demo board with no sign-up, and Connect, Pricing, Privacy, and Terms show their own titles and descriptions
- Each page names itself in the browser tab, like `Connect an agent · Tasks`, and Tasks has a home-screen icon on iPhone and iPad
- Signed out, `/tasks/` is a real front page: what Tasks is, the sign-in form, and a sample board showing an agent's question, a claimed card, and the Sessions list. Below that: what's different, including how an answer reaches your agent and that an encrypted board is closed to outside agents, the four-step quick start with the OAuth `claude mcp add` command under it, and a link to the demo board. On a phone the headline, the demo button, and a piece of the sample board come before the sign-in form
- Pricing is on the front page, readable before you sign up: the daily assistant limits for Free and Pro, and the Pro price as Stripe has it
- A mistyped address like `/tasks/nope` answers 404 Not Found and shows a not-found page with links to the pages that exist, instead of the sign-in form
- Until your first agent connects, the board says "No agent connected yet" above the lanes, and each `#agent` card says nothing will pick it up, with a link to Connect. With no `#agent` card yet, it says how to hand one over: add `#agent` to a card's title, or use the Tags field. It all goes away the moment an agent connects
- A demo board at `/tasks/demo` you can try without signing up: drag cards, answer an agent's question, and watch a scripted agent pick it up. Its other sessions keep moving too: one works through its tool calls, one goes quiet. It lives in your browser tab and nothing is saved, and Start over is always in the strip under the top bar, on a phone too
- The Connect page has a one-line starter prompt to copy into a newly connected agent, so it works `#agent` cards the right way from the first message
- One command sets up Sessions on a machine: it saves your token, installs the two scripts, and adds the hooks to `~/.claude/settings.json` without touching what's already there. It saves a backup of that file first and prints where it put it. The Connect page shows it with a new token filled in
- End a new card's title with `#agent` and it's tagged: "Write a haiku #agent" adds the card "Write a haiku" with the tag. Works in quick add, on each line of a pasted list, and in the new-card dialog, with several tags too. `#123`, `C#`, and a `#tag` in the middle of a title are left as typed
- The front page has `// CHECK_IT_YOURSELF`: links to the public code, the changelog with how many changes it holds, the encryption format, what Sessions stores, and who makes Tasks and why
- `/tasks/pricing` opens the front page at its pricing section, signed in or not

### Changed
- The privacy policy says what's kept when an agent claims a card: a session record and the claim, with or without the Claude Code hooks, when the session started and was last heard from, the optional link back to a session, and a copy of the agent's question with the claim while that question is open. It also covers the quick start's access token, questions and answers on cards, and the sign-in try counts kept by email and IP address
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
- "Connect an agent" is the first item in the account menu, and the Sessions list links to the hook setup. When a session there only claims cards (an agent connected by the quick start alone), a line under the list says why its row has no machine or resume command and links to the hooks
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
- "Need you" counts one decision once: a session waiting on a card that has an open question shows under that question instead of adding to the count
- With the Sessions hooks, a permission prompt you approved or denied stops reading "needs input" on the session's next tool call. It could sit there for a minute, counted in "need you" with nothing waiting
- A card's session line and the Sessions list show the same agent name. A later `claim_card` without `agent` put "agent" on the card
- An agent without hooks that finished and exited stops counting in "N live sessions" as soon as it holds no card, not 5 minutes later
- Tapping the search icon on a phone opens search
- iPhones no longer zoom in when you tap a field
- The "Add card" label in quick add was unreadable against its button
- Dragging a card to the edge of a phone screen brings in one lane at a time. It used to race to the last lane and drop the card in Done
- The account button no longer slides off screen when agents have questions open or sessions are reporting in
- Muted text in Solarized, Sakura, Ocean, and Nord was too faint to read comfortably
- Screen readers announce every button by name. The account button used to be read out as your email address
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

[Unreleased]: https://github.com/ddrscott/tasks-agent/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ddrscott/tasks-agent/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ddrscott/tasks-agent/releases/tag/v0.1.0
