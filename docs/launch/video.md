# Demo video shot list

A 75 second screen recording of the demo board at https://askscottpierce.com/tasks/demo. No
voice-over needed; the captions carry it. Not recorded yet.

## // SETUP

- Record the live site, not a dev server, so the footer shows a release.
- Browser window at 1270x760 or a multiple of it (the gallery's shape), dark theme, no bookmarks
  bar, no other tabs. Zoom 100%.
- Reload the page right before each take. A reload starts the demo's script over.
- Move the mouse slowly and stop it before you click.
- Captions: white on the bottom third, one line each, on screen long enough to read twice.
- The demo's agent runs on timers (`STEP_MS` in `src/client/Demo.tsx`). The moment you answer,
  its line says working and the card says `answered: …`. It writes its new status about 2.5
  seconds later, finishes the card about 8 seconds after that, picks
  up the next card 5 seconds later, and asks its next question 6 seconds after that. The beats
  below are timed to that. If those numbers change, re-time beats 4 through 6.
- Product Hunt takes a YouTube link only, and the video can't be private. Unlisted is fine.

## // BEATS

| # | Time | On screen | Caption |
|---|---|---|---|
| 1 | 0:00 to 0:06 | The demo board, still. Three lanes. In Doing, the card "Migrate the orders table to the new schema" has an orange `$ needs input` line and a question with three buttons. | Your coding agents work from this board. |
| 2 | 0:06 to 0:14 | Slow push in on that card. The question reads "The old orders.total column: drop it in this migration, or keep it a week?" The first option is outlined and marked REC. | This one hit a decision it shouldn't make alone. So it asked. |
| 3 | 0:14 to 0:19 | Mouse moves to "Keep it a week, drop it in a follow-up" and clicks. The buttons go away, and so does "need you" in the top bar: nothing is waiting. In the same moment the card's line changes to `$ working` and under it the card says "answered: Keep it a week, drop it in a follow-up". | One tap. |
| 4 | 0:19 to 0:31 | Hold on the card. A couple of seconds later "answered: …" gives way to the agent's status, "working — got your answer (…)", quoting the answer. Open the card: the notes start with `ANSWER:` and the same `STATUS: working` line. Close it. | The answer goes on the card, and the agent picks it up. |
| 5 | 0:31 to 0:38 | The card moves to Done on its own. | It finishes the card and moves it to Done. |
| 6 | 0:38 to 0:50 | "Rate limit the public search endpoint" moves from To do to Doing by itself, shows "picked up — reading the search handler" on its face (its `STATUS:` line), then a new question appears on it in place of that line. "Need you" comes back in the top bar. | Then it claims the next one. And asks again when it needs to. |
| 7 | 0:50 to 0:58 | Click "need you" in the top bar. The list opens: the open question with its buttons, and under it the line for the session that's waiting on it. | One list of everything waiting on you. |
| 8 | 0:58 to 1:05 | Close it. Click Sessions. Three sessions grouped by project: shop-api, shop-web, infra. One needs input, one is working, one is idle on another machine. | Every Claude Code session, on every machine. |
| 9 | 1:05 to 1:11 | Cut to a phone (or a 390-wide window): the same board, one lane wide. A thumb taps "?1" in the top bar, the "need you" list opens, and one tap on an answer sends it. This is what `06-phone.png` shows. | It's a web page. Answer from your phone. |
| 10 | 1:11 to 1:15 | Cut to a new account's empty board: `// START_HERE`, four numbered steps, the sample card added and the command copied (`05-quick-start.png`). Dot out the token if it's in frame. | Four steps to a working agent. |
| 11 | 1:15 to 1:20 | Back to the demo board, full frame, with the strip that says it's a demo. Hold. | Try the demo. No sign-up. askscottpierce.com/tasks |

That's 80 seconds. To get to 60, drop beats 8 and 10.

## // NOTES

- Beat 3: with a mouse, an answer on the card face is one click, and the caption says "One tap"
  over a mouse click, which is fair. On a real touch screen the card face takes two taps: the
  first turns the option into "Send: …?" and the second sends it. That's why beat 9 answers
  from the "need you" list, where it's one tap. Don't put a "one tap" caption over a thumb on a
  card face.
- Beat 4: the demo strip at the top says the agents are scripted. Leave it in frame. Cropping it
  out would make the video claim something the demo doesn't.
- Beat 8 says "Claude Code" in the caption on purpose. Agents without its hooks only
  get a row while they claim cards, and the demo's three are Claude Code sessions.
- Don't speed the footage up. The pauses while the agent works are what it's really like.
- Other work on the demo is landing around the same time as this kit. Before recording, click
  through the demo once and check the beats against what it does now.
