# Product Hunt launch copy

Everything the submission form asks for, ready to paste. Anything marked **SCOTT:** is a blank or
a call only you can make. Every claim here was checked against `README.md` on 2026-10-03; if the
product changes, change the copy.

Counts are checked by `npm run check:launch`, which reads the `<!-- count: … -->` lines in this
file. Edit a block, run it again.

## // LIMITS

From Product Hunt's own launch guide,
<https://www.producthunt.com/launch/preparing-for-launch>, read 2026-10-03:

| Field | What the guide says | What this kit uses |
|---|---|---|
| Name | "Only the product's name, no description or emojis." No length given. | 5 characters |
| Tagline | "max 60 characters", "no gimmicks or over-the-top language" | 60 |
| Description | "max 500 characters" | 260 (see below) |
| Launch tags | "up to 3" | 3 |
| Thumbnail | square, "We recommend 240x240", under 3 MB | 240x240 PNG |
| Gallery | "Two required", "recommended size ... is 1270x760", under 3 MB each | seven at 2540x1520 (1270x760 at 2x) |
| Video | "Only YouTube links are supported", not private, full URL | see `video.md` |
| Pricing | "free, paid, and paid (with a free trial or plan)" | see `// PRICING` |
| First comment | asked for in the form, shows right under the gallery | 150 to 250 words |

Two things I couldn't confirm from that page:

- **Description length.** The guide says 500. The usual advice, and older versions of the form,
  say 260. The description below fits in 260, so it's safe either way. If the form really gives
  you 500, the longer one is there too.
- **Name length.** The usual number is 40 characters. The guide doesn't state one. "Tasks" is 5.

## // NAME

<!-- count: chars 1-40 | name -->
```
Tasks
```

**SCOTT:** "Tasks" is the product's real name, and it's also about the most generic word on Product
Hunt. Search there for it before you submit. If something else already owns the name, the fallback
that stays inside their naming rule is `Tasks by Scott Pierce` (21 characters).

## // TAGLINE

Recommended:

<!-- count: chars 1-60 | tagline 1 (recommended) -->
```
A task board where agents ask and you answer in one tap
```

It says what the thing is and the one thing nobody else leads with. The others, in the order I'd
reach for them:

<!-- count: chars 1-60 | tagline 2 -->
```
Your coding agents ask on the card. You answer in one tap.
```

<!-- count: chars 1-60 | tagline 3 -->
```
One list of everything your coding agents are waiting on
```

<!-- count: chars 1-60 | tagline 4 -->
```
The task board your AI coding agents work from, over MCP
```

<!-- count: chars 1-60 | tagline 5 -->
```
A hosted kanban for Claude Code, Cursor, and Codex agents
```

| # | Tagline | Characters |
|---|---|---|
| 1 | A task board where agents ask and you answer in one tap | 55 |
| 2 | Your coding agents ask on the card. You answer in one tap. | 58 |
| 3 | One list of everything your coding agents are waiting on | 56 |
| 4 | The task board your AI coding agents work from, over MCP | 56 |
| 5 | A hosted kanban for Claude Code, Cursor, and Codex agents | 57 |

## // DESCRIPTION

<!-- count: chars 1-260 | description -->
```
A hosted kanban board your AI coding agents work over MCP. When one needs a decision, it asks on the card and you answer in one tap, from your desk or your phone. One list shows everything waiting on you. Nothing to install. Try the demo without signing up.
```

If the form allows 500:

<!-- count: chars 1-500 | description, long form -->
```
A hosted kanban board your AI coding agents work over MCP. Claude Code, Cursor, Codex, or any other MCP client picks up cards, claims them, and keeps a status line on each. When one needs a decision, it asks on the card with a few options and you answer in one tap, from your desk or your phone. One list shows every open question and every Claude Code session stopped at a prompt. Optional end-to-end encryption. Nothing to install. Try the demo without signing up.
```

## // TOPICS

Launch tags, up to three:

1. **Developer Tools**
2. **Artificial Intelligence**
3. **Task Management**

**SCOTT:** pick these from the form's own list; I couldn't open the picker without an account, so
the exact names may differ. If there's an "AI Coding Agents" or "AI Agents" tag (agentboards is
listed under both as categories), swap it in for Artificial Intelligence. Productivity is the
spare.

## // PRICING

What the branch does today: `STRIPE_PRICE_ID` is empty in `wrangler.jsonc`, so billing is off and
the landing page says "Pro isn't on sale yet."

- **If Pro is not on sale at launch:** choose **Free** on the form. Pricing line:

  ```
  Free. The board, MCP, questions, sessions, search, attachments, and encryption cost nothing, and your own agents are never capped. The built-in assistant gets 30 messages a day.
  ```

- **If Pro is on sale at launch:** choose **Paid (with a free trial or plan)**. Pricing line:

  ```
  Free plan: unlimited cards, lanes, and MCP calls, plus 30 assistant messages a day. Pro raises the assistant to 150 messages a day for ______ a ______. Everything else is the same on both.
  ```

  **SCOTT: fill in the two blanks from Stripe (amount, then month or year).** I don't know the
  price and the app never hard-codes it. The landing page reads it from Stripe once
  `STRIPE_PRICE_ID` is set, so check that the page and this line say the same number.

The 30 and 150 are `FREE_DAILY_CHATS` and `PRO_DAILY_CHATS`. If you change them, change these.

## // LINKS

| | |
|---|---|
| Website (the main link) | https://askscottpierce.com/tasks/ |
| Demo, no sign-up | https://askscottpierce.com/tasks/demo |
| Setup steps, readable signed out | https://askscottpierce.com/tasks/connect |
| Source | https://github.com/ddrscott/tasks-agent |
| Maker | https://askscottpierce.com |

**SCOTT:** the form also takes an X handle. The guide wants the product's, not yours. Tasks
doesn't have one, so leave it empty or use your own.

## // GALLERY

Shot from the running app by `npm run shots`. Files are in `docs/launch/gallery/`. Upload in this
order; the first image is the one Product Hunt uses when the launch is shared.

| File | Caption |
|---|---|
| `01-board-question.png` | An agent hit a decision it shouldn't make alone, so it asked on the card. The option it would pick is marked REC. Tap one and it goes back to work. |
| `02-need-you.png` | "Need you" is one list: every open question, and every Claude Code session stopped at a prompt. Clear them in a row. |
| `03-sessions.png` | Every Claude Code session that's reporting in, on any machine, grouped by project. Working, needs input, or idle, and the last thing each one did. |
| `04-card.png` | An open card: the session that claimed it, its question, and its notes in markdown with a STATUS line the agent keeps current. |
| `05-connect.png` | Setup is a URL and one command. There's a tab for Claude, ChatGPT, Glean, Claude Code, Cursor, VS Code, and Codex. |
| `06-phone.png` | It's a web page, so it works on your phone. Same board, same questions, same list. |
| `07-landing.png` | The front page. The board in it is the app's own components, not a picture. (Optional; drop it if seven is too many.) |
| `thumbnail-240.png` | The thumbnail: the favicon's three bars. |

The pictures in this folder were shot from a local dev server, so the footer in them shows a
branch commit and the Connect shot's address was swapped for the hosted one. Shoot them again
from the live site after the deploy; see `checklist.md`.

## // FIRST_COMMENT

<!-- count: words 150-250 | maker's first comment -->
```
Hi, I'm Scott. I built Tasks because I kept losing the thread.

I run a handful of coding agents across a few repos and a couple of machines. Even with good terminal tools, I still got lost moving my projects forward. Figuring out what was going on meant swimming through oceans of text, and half the time a session had been sitting on a question for an hour. So I went back to basics: a board.

What it does:

1. Your agent connects over MCP, picks up the cards you tagged for it, claims one, and keeps a status line on it.
2. When it needs a decision, it asks on the card with a few options and marks the one it would pick. You tap one.
3. "Need you" is one list of every open question and every Claude Code session stopped at a prompt, on any machine.

What's different: it's hosted, so there's nothing to install and it works from your phone. Any MCP client connects. Encryption is there if you want it.

What's rough: only Claude Code reports every step to the Sessions list; other agents show up there when they claim a card. It's one person's board, with no teams. An encrypted board is closed to agents. It won't start your agents or review their diffs. And it's a v0.1 from one guy.

One ask: try the demo, no sign-up, and tell me where it breaks.
https://askscottpierce.com/tasks/demo
```

**SCOTT:** "a handful", "a few repos", and "a couple of machines" are my guesses at your setup
from the README (two build boxes plus the Mac). Put your real numbers in if you'd rather.

## // READY_ANSWERS

Short on purpose. Paste, then add whatever the commenter actually asked.

**How is this different from Vibe Kanban?**

```
Different job. Vibe Kanban runs on your machine and orchestrates the agents: it starts them, and you review their work in it. Tasks doesn't start agents or look at diffs. It's a hosted board they report to over MCP, built around one moment: the agent needs a call from you, asks on the card, and you tap an answer from wherever you are. If you want the orchestration and review in one local app, that's their thing, not mine.
```

Their site carries a notice: "Vibe Kanban is sunsetting. The project will continue as open source
and community maintained." (seen 2026-10-03 at https://www.vibekanban.com). Don't bring it up. If a
commenter does, say it's a good project and leave it there.

**How is this different from agentboards?**

```
From their launch page, agentboards is about agents running their own board while you watch. Tasks leans the other way: the agent does the work, but when it reaches something it shouldn't decide alone, it stops and asks you, with options. The other thing I cared about is one list of what's waiting on me, across every session.
```

**SCOTT:** I only read their launch page (tagline: "AI agents manage their own work. You just
watch."). If you've used it, say what you actually found. If you haven't, say that.

**Why not just use Linear?**

```
Linear is a team issue tracker, and a good one. Tasks is a lot smaller: one person's board, where the cards are instructions for agents and the main feature is the agent asking you a multiple-choice question on the card. No teams, cycles, or roadmaps here. If you already live in Linear and it works with your agents, stay there.
```

**Does it work with Cursor / Codex / ChatGPT?**

```
Yes. It's a plain MCP server over HTTP with OAuth, so anything that speaks MCP can read and change the board and ask questions. The Connect page has steps for Claude, ChatGPT, Glean, Claude Code, Cursor, VS Code, and Codex. One honest limit: the live event feed and step-by-step session reporting are Claude Code only today, because they run on its hooks. Other agents show in Sessions as working while they hold a card, and see your answer the next time they read the board.
```

**What about privacy?**

```
The board holds card text and the files you attach. Session reporting is presence, not a log: session id, project folder, machine, state, and one line like "Edit: server.ts". No transcripts, prompts, or commands are stored. You can also encrypt the board with a passphrase in your browser, and then the server only has ciphertext. The catch is that an encrypted board is closed to outside agents, since the server can't read it either.
```

**Does my code leave my machine?**

```
Not through Tasks. Your agents run wherever you run them, and Tasks never sees your repo. What reaches it is what an agent writes on a card, anything you attach, and the session hook's report: about 200 bytes with the session id, folder path, event name, tool name, file path, and notification text. What your agent sends to its own model provider is between you and them.
```

**Is it open source?**

```
The source is public: https://github.com/ddrscott/tasks-agent. You can read all of it, including how the encryption works. It doesn't have a license file yet, so I won't call it open source until that's sorted.
```

**SCOTT:** if you add a LICENSE before launch (see `checklist.md`), replace the last sentence with
the license's name.

**What's in the free plan?**

```
Everything except a bigger assistant allowance. Cards, lanes, MCP calls, questions, sessions, search, attachments, and encryption are free and never capped. The built-in assistant gets 30 messages a day on Free, because that's the part that runs on my model bill.
```

**SCOTT:** if Pro is on sale, add: "Pro raises that to 150 a day."

**Is the demo real?**

```
The board is the real UI. The agent on it is scripted and nothing is saved, and the strip at the top says so. I'd rather you see how answering feels in ten seconds than sit through a sign-up first.
```

## // SHORTER_PITCHES

### X

<!-- count: chars 1-280 | X post -->
```
I built a task board for coding agents.

They pick up cards over MCP. When one needs a decision it asks on the card, and I tap an answer from my phone. One list shows everything waiting on me.

Demo, no sign-up: https://askscottpierce.com/tasks/demo
```

Attach `01-board-question.png`. X counts any link as 23 characters, so there's room to spare.

### LinkedIn

Title:

```
I got tired of hunting for the terminal that was waiting on me
```

```
I run several AI coding agents across a few repos, and I kept losing track of which one was stuck on a question. So I built Tasks: a hosted kanban board the agents work over MCP. When one needs a decision, it asks on the card with a few options and I answer in one tap, from my desk or my phone. There's a demo you can click through without signing up, and I'd like to hear where it breaks: https://askscottpierce.com/tasks/demo
```

### Hacker News

<!-- count: chars 1-80 | Show HN title -->
```
Show HN: Tasks – a kanban board where coding agents ask and you tap an answer
```

URL: `https://askscottpierce.com/tasks/demo` (Show HN wants something people can try without a
sign-up, and the demo is that). Then post this as the first comment:

```
I run a few Claude Code sessions at once and kept finding one that had been parked on a question for an hour. Tasks is a hosted board the agents work over MCP: they claim cards, keep a status line, and call a tool to ask me a multiple-choice question that shows up on the card as buttons. One list shows every open question plus every Claude Code session stopped at a prompt. It runs on Cloudflare Workers and Durable Objects, the source is public (no license yet), and an optional passphrase encrypts the board in the browser, which also closes it to agents. The demo's agent is scripted; tell me where it falls over.
```

**SCOTT:** the HN title uses an en dash after "Tasks", which is the house style there. It's the one
place in this kit with a dash like that.
