#!/usr/bin/env node
// Check lane sorting (src/shared.ts: sortedIds and orderLane): each sort gives the right
// order, ties keep their place, and only the sorted lane's cards move. Exits 1 on a failure.
//
//   npm run check:sort

import { build } from "esbuild";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;
const dir = join(root, "node_modules", ".cache", "check-sort");
const outfile = join(dir, `shared-${process.pid}.mjs`);
await build({ entryPoints: [join(root, "src/shared.ts")], outfile, bundle: true, format: "esm", platform: "node", logLevel: "error" });
const { sortedIds, orderLane, SORTS } = await import(pathToFileURL(outfile).href);
rmSync(dir, { recursive: true, force: true });

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(ok ? `ok   ${name}` : `FAIL ${name}\n     wanted ${JSON.stringify(want)}\n     got    ${JSON.stringify(got)}`);
}
function throws(name, fn) {
  try { fn(); failed++; console.log(`FAIL ${name}\n     it didn't throw`); } catch { console.log(`ok   ${name}`); }
}

const card = (id, laneId, title, due, createdAt, updatedAt) => ({ id, title, notes: "", laneId, due, createdAt, updatedAt });
const board = {
  theme: "auto",
  lanes: [{ id: "todo", name: "To do" }, { id: "done", name: "Done" }],
  cards: [
    card("a", "todo", "pay rent", "2026-10-09", "2026-01-03", "2026-03-01"),
    card("x", "done", "zebra", null, "2026-01-01", "2026-01-01"),
    card("b", "todo", "Item 10", null, "2026-01-01", "2026-05-01"),
    card("c", "todo", "item 2", "2026-10-01", "2026-01-04", "2026-02-01"),
    card("y", "done", "apple", "2026-01-01", "2026-01-02", "2026-01-02"),
    card("d", "todo", "Call mom", null, "2026-01-02", "2026-04-01"),
    card("e", "todo", "audit", "2026-10-01", "2026-01-05", "2026-01-09"),
  ],
};
const todo = board.cards.filter((c) => c.laneId === "todo");

check("due: soonest first, ties keep their place, no date last", sortedIds(todo, "due"), ["c", "e", "a", "b", "d"]);
check("title: ignores case, and 2 comes before 10", sortedIds(todo, "title"), ["e", "d", "c", "b", "a"]);
check("newest first", sortedIds(todo, "newest"), ["e", "c", "a", "d", "b"]);
check("oldest first", sortedIds(todo, "oldest"), ["b", "d", "a", "c", "e"]);
check("recently updated", sortedIds(todo, "updated"), ["b", "d", "a", "c", "e"]);
check("every menu entry sorts", SORTS.map((s) => sortedIds(todo, s.by).length), SORTS.map(() => 5));
check("sorting doesn't change the list it was given", todo.map((c) => c.id), ["a", "b", "c", "d", "e"]);
throws("an unknown sort is refused", () => sortedIds(todo, "color"));

const sorted = orderLane(board, "todo", sortedIds(todo, "due"));
check("orderLane: the lane is in the new order", sorted.cards.filter((c) => c.laneId === "todo").map((c) => c.id), ["c", "e", "a", "b", "d"]);
check("orderLane: other lanes keep their order", sorted.cards.filter((c) => c.laneId === "done").map((c) => c.id), ["x", "y"]);
check("orderLane: other lanes' cards keep their slots", [sorted.cards[1].id, sorted.cards[4].id], ["x", "y"]);
check("orderLane: no card is lost or changed", [...sorted.cards].sort((p, q) => p.id.localeCompare(q.id)), [...board.cards].sort((p, q) => p.id.localeCompare(q.id)));
check("orderLane: takes a lane name too", orderLane(board, "Done", ["y", "x"]).cards.filter((c) => c.laneId === "done").map((c) => c.id), ["y", "x"]);
throws("orderLane refuses a missing card", () => orderLane(board, "todo", ["a", "b", "c", "d"]));
throws("orderLane refuses a repeated card", () => orderLane(board, "todo", ["a", "a", "c", "d", "e"]));
throws("orderLane refuses a card from another lane", () => orderLane(board, "todo", ["a", "b", "c", "d", "x"]));
throws("orderLane refuses an unknown lane", () => orderLane(board, "nope", []));

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
