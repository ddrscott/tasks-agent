#!/usr/bin/env node
// Check the Sessions rules that don't need a server (src/presence-shared.ts): what a session
// that only claims cards says after a claim, a refused claim, and a release; how "unknown"
// reads; and that one decision counts once in "need you". Exits 1 on a failure.
//
//   npm run check:presence

import { build } from "esbuild";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;
const dir = join(root, "node_modules", ".cache", "check-presence");
const outfile = join(dir, `shared-${process.pid}.mjs`);
await build({ entryPoints: [join(root, "src/presence-shared.ts")], outfile, bundle: true, format: "esm", platform: "node", logLevel: "error" });
const { afterClaim, afterEnded, afterRelease, endedCards, askingSession, blockedSessions, needYouCount, isStale, known, projectName, whoWhere, STALE_MS } = await import(pathToFileURL(outfile).href);
rmSync(dir, { recursive: true, force: true });

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(ok ? `ok   ${name}` : `FAIL ${name}\n     wanted ${JSON.stringify(want)}\n     got    ${JSON.stringify(got)}`);
}

// ── A session that only claims ──────────────────────────────────────────────────────────────
const first = afterClaim(null, {}, "Fix login", true, 1);
check("a first claim is working and names the card by title", first,
  { project: "", machine: "", agent: "", state: "working", last: 'claimed "Fix login"' });

const refusedNew = afterClaim(null, { agent: "codex" }, "Fix login", false, 0);
check("a refused claim from a new session is idle and doesn't say it claimed", refusedNew,
  { project: "", machine: "", agent: "codex", state: "idle", last: 'asked for "Fix login", which another session holds' });
check("a refused claim never reads as claimed", /^claimed/.test(refusedNew.last), false);

check("a refused claim from a session holding another card stays working",
  afterClaim(first, {}, "Rate limits", false, 1).state, "working");

check("claiming again with agent, machine, and project updates all three",
  afterClaim(first, { agent: "cursor", machine: "mini", project: "shop-api" }, "Fix login", true, 1),
  { project: "shop-api", machine: "mini", agent: "cursor", state: "working", last: 'claimed "Fix login"' });
const told = afterClaim(null, { agent: "cursor", machine: "mini", project: "shop-api" }, "Fix login", true, 1);
check("claiming again without them keeps what it said before",
  afterClaim(told, {}, "Fix login", true, 1), told);
check("a later claim can change one of them",
  afterClaim(told, { project: "shop-web" }, "Fix login", true, 1).project, "shop-web");
check("a card with no title to give still reads", afterClaim(null, {}, "", true, 1).last, "claimed a card");

check("releasing its only card goes idle and says what it released",
  afterRelease(told, "Fix login", 0),
  { project: "shop-api", machine: "mini", agent: "cursor", state: "idle", last: 'released "Fix login"' });
check("releasing one of two cards stays working", afterRelease(told, "Fix login", 1).state, "working");

// ── A claimed card that's finished or gone ──────────────────────────────────────────────────
const lanes = [{ id: "todo", name: "To do" }, { id: "doing", name: "Doing" }, { id: "done", name: "Done" }];
const card = (id, laneId, title = id) => ({ id, laneId, title });
const b0 = { lanes, cards: [card("a", "doing", "Fix login"), card("b", "todo"), card("z", "done")] };
const moved = { lanes, cards: [card("a", "done", "Fix login"), card("b", "todo"), card("z", "done")] };
check("a card moved to the last lane has ended, and one already there hasn't", endedCards(b0, moved, "agent"),
  [{ cardId: "a", title: "Fix login", how: "done", lane: "Done", by: "agent" }]);
check("a card moved between other lanes hasn't ended",
  endedCards(b0, { lanes, cards: [card("a", "todo"), card("b", "doing"), card("z", "done")] }, "you"), []);
check("moving a card back out of the last lane ends nothing", endedCards(moved, b0, "you"), []);
check("a deleted card has ended", endedCards(b0, { lanes, cards: [card("b", "todo"), card("z", "done")] }, "you"),
  [{ cardId: "a", title: "Fix login", how: "deleted", lane: "", by: "you" }]);
check("a card added straight to the last lane has ended", endedCards(b0, { lanes, cards: [...b0.cards, card("n", "done")] }, "you").map((e) => e.cardId), ["n"]);
check("a lane that becomes the last one ends its cards",
  endedCards(b0, { lanes: [lanes[0], lanes[2], lanes[1]], cards: b0.cards }, "you").map((e) => [e.cardId, e.lane]), [["a", "Doing"]]);
check("renaming a card ends nothing", endedCards(b0, { lanes, cards: [card("a", "doing", "Fix sign-in"), card("b", "todo"), card("z", "done")] }, "you"), []);
check("a board with one lane has no done lane",
  endedCards({ lanes: [lanes[0]], cards: [] }, { lanes: [lanes[0]], cards: [card("a", "todo")] }, "you"), []);
check("the same board ends nothing", endedCards(b0, b0, "you"), []);

check("an agent that moved its only card to the last lane is idle and finished it",
  afterEnded(told, { title: "Fix login", how: "done", lane: "Done", by: "agent" }, 0),
  { project: "shop-api", machine: "mini", agent: "cursor", state: "idle", last: 'finished "Fix login"' });
check("when the person moved it, the line says so instead of crediting the session",
  afterEnded(told, { title: "Fix login", how: "done", lane: "Shipped", by: "you" }, 0).last, '"Fix login" was moved to Shipped');
check("a deleted card says it was deleted, and the session goes idle",
  [afterEnded(told, { title: "Fix login", how: "deleted", lane: "", by: "you" }, 0).state, afterEnded(told, { title: "Fix login", how: "deleted", lane: "", by: "agent" }, 0).last],
  ["idle", '"Fix login" was deleted']);
check("finishing one of two cards stays working", afterEnded(told, { title: "Fix login", how: "done", lane: "Done", by: "agent" }, 1).state, "working");
check("a finished card never reads as working on it", /claimed|working/.test(afterEnded(told, { title: "Fix login", how: "done", lane: "Done", by: "agent" }, 0).last), false);

// ── Reading "unknown" ───────────────────────────────────────────────────────────────────────
check("the word unknown counts as not known", [known("unknown"), known(""), known("mini")], ["", "", "mini"]);
check("no project is listed under No project", [projectName({ project: "" }), projectName({ project: "unknown" }), projectName({ project: "shop-api" })],
  ["No project", "No project", "shop-api"]);
check("who and where leaves out what isn't known",
  [whoWhere({ agent: "lead", machine: "mini" }), whoWhere({ agent: "lead", machine: "unknown" }), whoWhere({ agent: "", machine: "mini" }), whoWhere({ agent: "", machine: "" })],
  ["lead · mini", "lead", "mini", "agent"]);

// ── One decision counts once ────────────────────────────────────────────────────────────────
const NOW = 1_800_000_000_000;
const sess = (id, state, quietMs = 1000) => ({ id, project: "p", machine: "m", agent: "", state, last: "", cwd: "", link: "", startedAt: NOW - 60_000, seenAt: NOW - quietMs });
const ask = { question: "?", options: ["a", "b"], askedAt: "2026-10-03T01:00:00.000Z" };
const asked = { id: "c1", ask };
const plain = { id: "c2" };
const claim = (cardId, sessionId) => ({ cardId, sessionId, agent: "lead", claimedAt: NOW });
const p = (sessions, claims) => ({ sessions, claims, now: NOW });

check("a question alone counts 1", needYouCount([asked, plain], p([], [])), 1);
check("a blocked session alone counts 1", needYouCount([plain], p([sess("s1", "needs-input")], [])), 1);
check("a question whose claiming session is blocked counts 1, not 2",
  needYouCount([asked, plain], p([sess("s1", "needs-input")], [claim("c1", "s1")])), 1);
check("that session isn't in the blocked list", blockedSessions([sess("s1", "needs-input")], NOW, [claim("c1", "s1")], [asked]).length, 0);
check("and it's the session shown under the question", askingSession(asked, [sess("s1", "needs-input")], [claim("c1", "s1")], NOW)?.id, "s1");
check("a blocked session holding a card with no question still counts",
  needYouCount([asked, plain], p([sess("s1", "needs-input")], [claim("c2", "s1")])), 2);
check("a blocked session that holds nothing still counts beside a question",
  needYouCount([asked], p([sess("s1", "needs-input")], [])), 2);
check("a different blocked session still counts beside a question that has its own",
  needYouCount([asked], p([sess("s1", "needs-input"), sess("s2", "needs-input")], [claim("c1", "s1")])), 2);
check("a working session on a card with a question adds nothing",
  needYouCount([asked], p([sess("s1", "working")], [claim("c1", "s1")])), 1);
check("no session is shown under a question whose session is working", askingSession(asked, [sess("s1", "working")], [claim("c1", "s1")], NOW), null);
check("a stale blocked session doesn't count", needYouCount([plain], p([sess("s1", "needs-input", STALE_MS + 1)], [])), 0);
check("stale starts after 5 quiet minutes", [isStale(sess("s", "idle", STALE_MS), NOW), isStale(sess("s", "idle", STALE_MS + 1), NOW)], [false, true]);
check("once the question is answered the blocked session counts on its own",
  needYouCount([{ id: "c1" }], p([sess("s1", "needs-input")], [claim("c1", "s1")])), 1);
check("blocked sessions list longest wait first",
  blockedSessions([sess("a", "needs-input", 1000), sess("b", "needs-input", 9000)], NOW, [], []).map((s) => s.id), ["b", "a"]);

console.log(failed ? `\n${failed} failed` : "\nall presence checks passed");
process.exit(failed ? 1 : 0);
