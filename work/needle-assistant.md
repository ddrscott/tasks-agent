# Needle in the assistant, GLM as the fallback

Status: done 2026-09-27, deployed. Owner: Scott. Tracked in `work/queue.md`.

## Problem

Every assistant message today is a GLM round trip on Workers AI: a full board in the
prompt, a few hundred output tokens, half a second to a few seconds, and it counts
against the daily cap. Most messages are one plain intent ("finished the roofer call",
"add taxes for Friday", "move the deck to Friday"). A 121M tool-calling model answers
those in about a quarter second in the browser tab, for free, with a confidence on the
call and a probability for every option it picked. needle-rs already runs that model in
the browser at askscottpierce.com/needle-rs.

## The design

- **Needle runs in the tab**, in a Web Worker, the same way the needle-rs demo does:
  the wasm engine (vendored under `public/tasks/needle/`), the weights fetched once from
  Hugging Face and kept in Cache Storage (35 MB, pinned revision, SHA-256 checked).
- **The board is the tool schema.** Needle can't be told card ids, so the client builds
  tools from the board: `move_card(card: enum of open titles, lane: enum of lane names)`,
  `add_card(title, lane?, due?)`, `update_card(card: enum, due?, title?)`,
  `delete_card(card: enum)`. `decide()` then returns a probability for every enum
  option, which is the "which card did they mean" answer with a number on it. Titles
  map back to ids on the client.
- **The gate.** A turn is handled locally only when the engine returned at least one
  call, its confidence clears the threshold, every enum argument's chosen option clears
  it too, and every relative date resolved to a real date. Otherwise the message goes
  to GLM exactly as today.
- **Applying.** A new `@callable() applyLocal` on `TodoAgent` runs the resolved board
  tools under one undo group and writes the user message and an assistant message with
  the same tool parts the GLM path produces into the chat transcript, so the sidebar,
  undo, and every open tab see the turn the same way. Local turns don't count against the
  daily cap; a capped user keeps the local assistant.
- **The bench decides the threshold.** `bench/needle.mjs` runs the 80 hand-labeled cases
  through the same tool-building code in Node (the exact wasm build, the local weights)
  and `bench/run.mjs --score` reports accuracy, latency, and, per threshold, how many
  commands the local path would take and how many it would get wrong.

## Acceptance criteria

- [x] `npm run bench:needle` writes `bench/results/needle.jsonl`; `--score` prints the Needle
      arm next to GLM and Jev with a per-threshold table (`--resolve` re-runs only the rules).
- [~] Zero wrong actions on the bench at every threshold; 17 of 80 commands taken at 0.8
      (25% of the actionable ones). That's precision first, not "a majority": the small
      model's coverage is the ceiling, and the doubtful ones go to GLM.
- [x] In the app: "finished the roofer call" applied in 245 ms with no HTTP request, ✓ line
      and reply in the chat, one undo step ("Undid: agent moved cards"), same transcript in a
      second tab. Checked in a browser on 2026-09-27.
- [x] "what's due this week?" and a two-clause command went to GLM; the footer under the
      message box reads "last: this tab" or "last: cloud" with the reason in its tooltip.
- [x] Cold load 2.1 s (engine files from `/tasks/needle/`, weights from Hugging Face, then
      Cache Storage); the cloud path works throughout and if the load fails.
- [x] README `// STACK`, `// HOW_IT_WORKS`, and `// ROUTING_BENCH` describe the two paths.

## Relevant files

- `src/client/needle.ts` (engine in a worker), `src/client/needle.worker.ts`
- `src/needle-tools.ts` (board → tools, envelope → board tool calls, relative dates)
- `src/agent.ts` (`applyLocal`), `src/client/Chat.tsx` (routing, the path indicator)
- `public/tasks/needle/pkg*/` (vendored from `../needle-rs/web/`)
- `bench/needle.mjs`, `bench/run.mjs`

## Constraints

- Nothing invented in the transcript: local turns are recorded with real tool outputs.
- The wasm and weights never block first paint or the board.
- Keep the one code path for changes: every local action still ends in `runTool`.

## Log

- 2026-09-27: design written; bench arm and client wiring next.
- 2026-09-27: first bench, enum-of-titles schema: 17/80 raw, 0 of 53 moves, calls withheld.
  Switched to verb tools with free-text task words and a client-side matcher.
- 2026-09-27: verb schema: 27/80 raw; fast path at 0.8 took 20, 5 wrong (a verb the message
  didn't say, "and" with one call, a note edit, a lane guessed by position).
- 2026-09-27: corroboration rules, shared-stem matcher, lanes by name: 17 taken, 0 wrong at
  every threshold. Browser check passed. Shipped.
- Seen in the browser check, not from this change: the cloud model once replied "Moved the
  domain renewal to Doing" with no tool call and no move (GLM claiming an action); the N/30
  counter is per tab; the board dims while the assistant panel is open.
