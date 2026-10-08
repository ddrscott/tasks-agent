#!/usr/bin/env node
// Check the special lanes (src/lanes.ts and the lane reducers in src/shared.ts): to do, doing,
// and done are roles a lane holds, not places on the board. A board from before roles reads
// them off its lane names, then off position, and keeps them once its lanes change. Exits 1 on
// a failure.
//
//   npm run check:lanes

import { build } from "esbuild";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;
const dir = join(root, "node_modules", ".cache", "check-lanes");
const load = async (entry, plugins = []) => {
  const outfile = join(dir, `${entry.replace(/\W/g, "-")}-${process.pid}.mjs`);
  await build({ entryPoints: [join(root, entry)], outfile, bundle: true, format: "esm", platform: "node", logLevel: "error", plugins });
  return import(pathToFileURL(outfile).href);
};
// events.ts also holds the Durable Object; stand in for the Workers runtime it imports.
const stubs = {
  name: "stubs",
  setup(b) {
    b.onResolve({ filter: /^(cloudflare:workers|agents)$/ }, (a) => ({ path: a.path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export class DurableObject {}; export const waitUntil = () => {}; export const getAgentByName = () => {};" }));
  },
};
const { newBoard, laneRoles, roleOf, doneLaneId, todoLaneId, moveLane, renameLane, addLane, deleteLane, setLaneRole, addCard, describeBoard } = await load("src/shared.ts");
const { endedCards } = await load("src/presence-shared.ts");
const { agentQueue } = await load("src/events.ts", [stubs]);
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

const card = (id, laneId, tags = ["agent"]) => ({ id, title: id, notes: "", laneId, due: null, tags, createdAt: "", updatedAt: "" });
const names = (b) => b.lanes.map((l) => l.name);
const roles = (b) => { const r = laneRoles(b.lanes); const n = (id) => b.lanes.find((l) => l.id === id)?.name; return { todo: n(r.todo), doing: n(r.doing), done: n(r.done) }; };

// ── A new board ─────────────────────────────────────────────────────────────────────────────
const fresh = newBoard();
check("a new board's lanes carry their roles", fresh.lanes.map((l) => l.role), ["todo", "doing", "done"]);

// ── A board from before roles ───────────────────────────────────────────────────────────────
const old = (...lanes) => ({ theme: "auto", lanes: lanes.map(([id, name]) => ({ id, name })), cards: [] });
check("roles are read off the names", roles(old(["a", "To do"], ["b", "Doing"], ["c", "Done"])), { todo: "To do", doing: "Doing", done: "Done" });
// The board this was written for: the lane with id "done" was renamed, and Done sits third of four.
const scotts = { ...old(["todo", "To do"], ["doing", "Doing"], ["l0axn", "Done"], ["done", "Waiting on them"]), cards: [card("x", "l0axn"), card("w", "done"), card("t", "todo")] };
check("Done is done by name even when another lane comes after it", roles(scotts), { todo: "To do", doing: "Doing", done: "Done" });
check("a lane's id says nothing: the one with id \"done\" isn't the done lane", doneLaneId(scotts.lanes), "l0axn");
check("with no lane called Done, the last lane is done and the first takes new cards", roles(old(["a", "Inbox"], ["b", "Now"], ["c", "Later"], ["d", "Shipped"])), { todo: "Inbox", done: "Shipped" });
check("three lanes with other names: first, middle, last", roles(old(["a", "Inbox"], ["b", "Now"], ["c", "Shipped"])), { todo: "Inbox", doing: "Now", done: "Shipped" });
check("one lane: it takes new cards and nothing is done", roles(old(["a", "Stuff"])), { todo: "Stuff" });
check("two lanes", roles(old(["a", "Open"], ["b", "Closed"])), { todo: "Open", done: "Closed" });
check("an encrypted board's names can't be read, so position decides", roles(old(["a", "eyJ.x"], ["b", "eyJ.y"], ["c", "eyJ.z"])).done, "eyJ.z");

// ── Position stops mattering ────────────────────────────────────────────────────────────────
const b3 = old(["a", "Inbox"], ["b", "Now"], ["c", "Shipped"]);
const shuffled = moveLane(b3, "c", 0);
check("moving the done lane to the front: the order changes", names(shuffled), ["Shipped", "Inbox", "Now"]);
check("…and it's still the done lane, with the roles now stored", [roles(shuffled), shuffled.lanes.map((l) => l.role)], [{ todo: "Inbox", doing: "Now", done: "Shipped" }, ["done", "todo", "doing"]]);
const grown = addLane(b3, "Waiting").board;
check("a lane added at the end doesn't become the done lane", roles(grown), { todo: "Inbox", doing: "Now", done: "Shipped" });
check("a renamed lane keeps its role", roles(renameLane(old(["a", "To do"], ["b", "Doing"], ["c", "Done"]), "c", "Shipped")).done, "Shipped");
check("renaming another lane to Done doesn't take the role", roles(renameLane(renameLane(old(["a", "To do"], ["b", "Doing"], ["c", "Done"]), "c", "Shipped"), "b", "Done")).done, "Shipped");
const noDone = deleteLane(old(["a", "To do"], ["b", "Doing"], ["c", "Done"]), "c");
check("deleting the done lane leaves the board without one", [roles(noDone), doneLaneId(noDone.lanes)], [{ todo: "To do", doing: "Doing" }, null]);
const noTodo = deleteLane(old(["a", "To do"], ["b", "Doing"], ["c", "Done"]), "a");
check("with no to do lane, new cards go to the first lane", [laneRoles(noTodo.lanes).todo ?? null, todoLaneId(noTodo.lanes)], [null, "b"]);

// ── Handing a role over ─────────────────────────────────────────────────────────────────────
const handed = setLaneRole(grown, "Waiting", "done");
check("making another lane the done lane takes the role from the old one", roles(handed), { todo: "Inbox", doing: "Now", done: "Waiting" });
check("a lane holds one role: giving the to do lane the done role frees to do", roles(setLaneRole(b3, "a", "done")), { doing: "Now", done: "Inbox" });
check("null makes it an ordinary lane", roleOf(setLaneRole(b3, "c", null).lanes, "c") ?? null, null);
throws("an unknown role is refused", () => setLaneRole(b3, "c", "archive"));
throws("an unknown lane is refused", () => setLaneRole(b3, "nope", "done"));

// ── What hangs off the roles ────────────────────────────────────────────────────────────────
check("a card with no lane named goes to the to do lane, wherever it sits", addCard(moveLane(scotts, "todo", 3), { title: "New" }).card.laneId, "todo");
check("the feed's hello leaves out cards in Done, though it isn't last", agentQueue(scotts).cards.map((c) => c.id), ["w", "t"]);
check("get_board marks the special lanes", describeBoard(scotts).split("\n").filter((l) => !l.startsWith("  ")).map((l) => l.replace(/, \d+ cards.*$/, ")")),
  ["To do (lane id todo, the to do lane)", "Doing (lane id doing, the doing lane)", "Done (lane id l0axn, the done lane)", "Waiting on them (lane id done)"]);
const lc = (b) => ({ lanes: b.lanes, cards: b.cards });
check("dragging the lanes around ends no claim", endedCards(lc(scotts), lc(moveLane(scotts, "l0axn", 3))), []);
check("a card moved into Done has ended", endedCards(lc(scotts), { lanes: scotts.lanes, cards: [card("x", "l0axn"), card("w", "done"), card("t", "l0axn")] }).map((e) => [e.cardId, e.lane]), [["t", "Done"]]);
check("a card moved into the last lane, which isn't done, hasn't", endedCards(lc(scotts), { lanes: scotts.lanes, cards: [card("x", "l0axn"), card("w", "done"), card("t", "done")] }), []);
check("making a lane the done lane ends the cards in it", endedCards(lc(scotts), lc(setLaneRole(scotts, "done", "done"))).map((e) => [e.cardId, e.lane]), [["w", "Waiting on them"]]);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
