#!/usr/bin/env node
// Check the agent event feed (src/events.ts: agentEvents and agentQueue): #agent and
// #gauntlet cards both publish, other cards never do. Exits 1 on a failure.
//
//   npm run check:events

import { build } from "esbuild";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;
const dir = join(root, "node_modules", ".cache", "check-events");
const outfile = join(dir, `events-${process.pid}.mjs`);
// events.ts also holds the Durable Object; stand in for the Workers runtime it imports.
const stubs = {
  name: "stubs",
  setup(b) {
    b.onResolve({ filter: /^(cloudflare:workers|agents)$/ }, (a) => ({ path: a.path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export class DurableObject {}; export const getAgentByName = () => {};" }));
  },
};
await build({ entryPoints: [join(root, "src/events.ts")], outfile, bundle: true, format: "esm", platform: "node", logLevel: "error", plugins: [stubs] });
const { agentEvents, agentQueue } = await import(pathToFileURL(outfile).href);
rmSync(dir, { recursive: true, force: true });

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(ok ? `ok   ${name}` : `FAIL ${name}\n     wanted ${JSON.stringify(want)}\n     got    ${JSON.stringify(got)}`);
}

const lanes = [{ id: "todo", name: "To do" }, { id: "done", name: "Done" }];
const card = (id, tags, laneId = "todo") => ({ id, title: id, notes: "", laneId, tags, createdAt: "", updatedAt: "" });
const board = (...cards) => ({ lanes, cards });
const types = (before, after) => agentEvents(before, after).map((e) => `${e.type}:${e.id}`);

check("a new #agent card is added", types(board(), board(card("a", ["agent"]))), ["added:a"]);
check("a new #gauntlet card is added", types(board(), board(card("g", ["gauntlet", "todo-agent"]))), ["added:g"]);
check("a card with neither tag says nothing", types(board(), board(card("x", ["todo-agent"]))), []);
check("putting #gauntlet on a card is tagged", types(board(card("g", [])), board(card("g", ["gauntlet"]))), ["tagged:g"]);
check("adding #gauntlet to an #agent card is an edit", types(board(card("g", ["agent"])), board(card("g", ["agent", "gauntlet"]))), ["edited:g"]);
check("moving a #gauntlet card is moved", types(board(card("g", ["gauntlet"])), board(card("g", ["gauntlet"], "done"))), ["moved:g"]);
check("taking #needs-ceo off a #gauntlet card is answered", types(board(card("g", ["gauntlet", "needs-ceo"])), board(card("g", ["gauntlet"]))), ["answered:g"]);
check("deleting a #gauntlet card is deleted", types(board(card("g", ["gauntlet"])), board()), ["deleted:g"]);
check("deleting an untagged card says nothing", types(board(card("x", [])), board()), []);
check("hello lists open #agent and #gauntlet cards only",
  agentQueue(board(card("a", ["agent"]), card("g", ["gauntlet"]), card("x", []), card("d", ["gauntlet"], "done"))).cards.map((c) => c.id), ["a", "g"]);
check("an encrypted board publishes nothing", agentEvents(board(), { ...board(card("g", ["gauntlet"])), sealed: {} }), []);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
