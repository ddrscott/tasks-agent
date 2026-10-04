#!/usr/bin/env node
// Check when the board says "No agent connected yet" (src/shared.ts: markAgentSeen,
// agentConnected, needsAgent, waitsForAgent, keepSettings). Exits 1 on a failure.
//
//   npm run check:nudge

import { build } from "esbuild";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;
const dir = join(root, "node_modules", ".cache", "check-nudge");
const outfile = join(dir, `shared-${process.pid}.mjs`);
await build({ entryPoints: [join(root, "src/shared.ts")], outfile, bundle: true, format: "esm", platform: "node", logLevel: "error" });
const { markAgentSeen, agentConnected, needsAgent, waitsForAgent, keepSettings, addCard, updateCard, moveCard, deleteCards, newBoard } = await import(pathToFileURL(outfile).href);
rmSync(dir, { recursive: true, force: true });

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(ok ? `ok   ${name}` : `FAIL ${name}\n     wanted ${JSON.stringify(want)}\n     got    ${JSON.stringify(got)}`);
}

const lanes = [{ id: "todo", name: "To do" }, { id: "done", name: "Done" }];
const card = (id, tags, laneId = "todo", extra = {}) => ({ id, title: id, notes: "", laneId, due: null, tags, createdAt: "", updatedAt: "", ...extra });
const board = (...cards) => ({ lanes, cards, theme: "auto" });
const T1 = "2026-10-03T01:00:00.000Z";
const T2 = "2026-10-04T01:00:00.000Z";
const sealed = { v: 1, kid: "k", envelope: "e", since: T1 };

// Whether to say it at all.
check("an empty board says nothing (// START_HERE has it)", needsAgent(board()), false);
check("a board with a card and no agent says it", needsAgent(board(card("x", []))), true);
check("once an agent connected it stops", needsAgent(markAgentSeen(board(card("x", [])), T1)), false);
check("an encrypted board never says it", needsAgent({ ...board(card("x", ["agent"])), sealed }), false);
check("a question on a card proves an agent was here", needsAgent(board(card("x", [], "todo", { ask: { question: "?", options: ["a", "b"], askedAt: T1 } }))), false);
check("so does an answer", needsAgent(board(card("x", [], "todo", { answer: { question: "?", answer: "a", at: T1 } }))), false);

// Recording the first call.
const seen = markAgentSeen(board(card("x", [])), T1);
check("the first call is stamped", seen.agentSeenAt, T1);
check("a later call changes nothing, and hands back the same board", markAgentSeen(seen, T2) === seen, true);
check("an encrypted board records nothing", markAgentSeen({ ...board(), sealed }, T1).agentSeenAt, undefined);
check("an empty board records it too, so the nudge never shows later", agentConnected(markAgentSeen(board(), T1)), true);
check("stamping leaves lanes and cards alone", [seen.lanes, seen.cards], [lanes, [card("x", [])]]);

// Which cards say it.
const b = board(card("a", ["agent"]), card("g", ["gauntlet"]), card("x", ["home"]), card("d", ["agent"], "done"));
check("#agent and #gauntlet cards that aren't done say it", b.cards.filter((c) => waitsForAgent(b, c)).map((c) => c.id), ["a", "g"]);
check("no card says it once an agent connected", markAgentSeen(b, T1).cards.filter((c) => waitsForAgent(markAgentSeen(b, T1), c)).length, 0);
check("no card says it on an encrypted board", b.cards.filter((c) => waitsForAgent({ ...b, sealed }, c)).length, 0);
const one = { ...board(card("a", ["agent"])), lanes: [lanes[0]] };
check("with one lane there's no done lane, so the card says it", waitsForAgent(one, one.cards[0]), true);

// It survives everything a board goes through.
let live = markAgentSeen(newBoard(), T1);
const added = addCard(live, { title: "Ship it", tags: ["agent"] });
live = moveCard(updateCard(added.board, added.card.id, { title: "Ship it now" }), added.card.id, "done", 0);
check("adding, editing, and moving cards keep it", live.agentSeenAt, T1);
check("deleting every card keeps it", deleteCards(live, [added.card.id]).agentSeenAt, T1);
check("undo to a board from before the agent keeps it", keepSettings(board(card("x", [])), seen).agentSeenAt, T1);
check("undo can't bring it back from an old board", keepSettings(seen, board()).agentSeenAt, undefined);
check("undo keeps the theme and the passphrase envelope too",
  keepSettings({ ...board(), theme: "nord", sealed: { ...sealed, kid: "old" } }, { ...board(), theme: "paper", themeChosen: true, sealed }),
  { lanes, cards: [], theme: "paper", themeChosen: true, sealed });
check("a board that isn't encrypted comes back with no envelope", "sealed" in keepSettings({ ...board(), sealed }, board()), false);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
