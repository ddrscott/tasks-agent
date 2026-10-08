#!/usr/bin/env node
// Check card claims. First the rule that needs no server (endedCards in src/presence-shared.ts):
// which board changes end a claim. Then, given a local dev server, the whole thing the way an
// agent with nothing but MCP lives it: get_started hands out a session id, one agent claims a
// card and a second is refused, the first asks a question, the owner answers, wait_for_answer
// hands the answer back, and the card is released. Exits 1 on a failure.
//
//   npm run check:claims                              # the rule only
//   npm run dev:local -- --port 5231 --strictPort     # in another terminal, then:
//   npm run check:claims -- http://localhost:5231     # the rule and the live run
//
// The live run needs DEV_LOGIN_CODES=1 (the sign-in code comes back in the API response) and
// refuses anything but localhost: it signs up a throwaway account.

import { build } from "esbuild";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

const root = new URL("..", import.meta.url).pathname;
const dir = join(root, "node_modules", ".cache", "check-claims");
const outfile = join(dir, `shared-${process.pid}.mjs`);
await build({ entryPoints: [join(root, "src/presence-shared.ts")], outfile, bundle: true, format: "esm", platform: "node", logLevel: "error" });
const { endedCards } = await import(pathToFileURL(outfile).href);
rmSync(dir, { recursive: true, force: true });

let failed = 0;
function check(name, got, want = true) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(ok ? `ok   ${name}` : `FAIL ${name}\n     wanted ${JSON.stringify(want)}\n     got    ${JSON.stringify(got)}`);
}

// ── A claimed card that's finished or gone ──────────────────────────────────────────────────
const lanes = [{ id: "todo", name: "To do" }, { id: "doing", name: "Doing" }, { id: "done", name: "Done" }];
const card = (id, laneId, title = id) => ({ id, laneId, title });
const b0 = { lanes, cards: [card("a", "doing", "Fix login"), card("b", "todo"), card("z", "done")] };
const moved = { lanes, cards: [card("a", "done", "Fix login"), card("b", "todo"), card("z", "done")] };
check("a card moved to the done lane has ended, and one already there hasn't", endedCards(b0, moved), [{ cardId: "a", how: "done", lane: "Done" }]);
check("a card moved between other lanes hasn't ended", endedCards(b0, { lanes, cards: [card("a", "todo"), card("b", "doing"), card("z", "done")] }), []);
check("moving a card back out of the done lane ends nothing", endedCards(moved, b0), []);
check("a deleted card has ended", endedCards(b0, { lanes, cards: [card("b", "todo"), card("z", "done")] }), [{ cardId: "a", how: "deleted", lane: "" }]);
check("a card added straight to the done lane has ended", endedCards(b0, { lanes, cards: [...b0.cards, card("n", "done")] }).map((e) => e.cardId), ["n"]);
check("moving the lanes around ends nothing: Done is done wherever it sits", endedCards(b0, { lanes: [lanes[0], lanes[2], lanes[1]], cards: b0.cards }), []);
check("a lane that's made the done lane ends its cards",
  endedCards(b0, { lanes: [lanes[0], { ...lanes[1], role: "done" }, lanes[2]], cards: b0.cards }).map((e) => [e.cardId, e.lane]), [["a", "Doing"]]);
check("renaming a card ends nothing", endedCards(b0, { lanes, cards: [card("a", "doing", "Fix sign-in"), card("b", "todo"), card("z", "done")] }), []);
check("a board with one lane has no done lane", endedCards({ lanes: [lanes[0]], cards: [] }, { lanes: [lanes[0]], cards: [card("a", "todo")] }), []);
check("the same board ends nothing", endedCards(b0, b0), []);

// ── The live run ────────────────────────────────────────────────────────────────────────────
const BASE = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!BASE) {
  console.log("\n(no server given, so the live run was skipped: npm run check:claims -- http://localhost:5231)");
} else {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE).hostname)) {
    console.error(`check:claims only runs against a local dev server, not ${new URL(BASE).hostname}. It creates an account.`);
    process.exit(2);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function call(cookie, method, path, body, headers = {}) {
    const r = await fetch(`${BASE}/tasks${path}`, {
      method, redirect: "manual", signal: AbortSignal.timeout(30_000),
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, data, text, headers: r.headers };
  }
  /** One MCP tool call over Streamable HTTP with a personal access token. */
  async function mcp(token, name, args = {}) {
    const r = await fetch(`${BASE}/tasks/mcp`, {
      method: "POST", signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const raw = await r.text();
    const payload = raw.includes("data:") ? raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("") : raw;
    let data = null;
    try { data = JSON.parse(payload); } catch { /* leave it */ }
    const text = (data?.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return { status: r.status, isError: !!data?.result?.isError || !!data?.error, text: text || raw.slice(0, 300) };
  }

  console.log(`\n# an agent with only MCP, against ${BASE}`);
  const run = randomBytes(4).toString("hex");
  const email = `claims-${run}@example.com`;
  const start = await call(null, "POST", "/api/auth/start", { email, turnstile: "XXXX.DUMMY.TOKEN.XXXX" });
  if (!start.data?.devCode) { console.error(`No dev sign-in code: is this a dev server with DEV_LOGIN_CODES=1? ${start.status} ${start.text.slice(0, 200)}`); process.exit(2); }
  const verify = await call(null, "POST", "/api/auth/verify", { email, code: start.data.devCode });
  const cookie = (verify.headers.get("set-cookie") ?? "").split(";")[0];
  const token = (await call(cookie, "POST", "/api/tokens", { name: "check claims" })).data.token;

  // The owner's side: the board socket, to answer the question the way the app's button does.
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/tasks/agent?_pk=${run}`, { headers: { Cookie: cookie } });
  const frames = [];
  ws.on("message", (d) => { try { frames.push(JSON.parse(d.toString())); } catch { /* not JSON */ } });
  await new Promise((done, no) => { ws.on("open", done); ws.on("error", no); });
  const rpc = async (method, args) => {
    const id = randomBytes(6).toString("hex");
    ws.send(JSON.stringify({ type: "rpc", id, method, args }));
    for (let i = 0; i < 100; i++) {
      const hit = frames.find((f) => f.type === "rpc" && f.id === id);
      if (hit) return hit;
      await sleep(50);
    }
    return { success: false, error: "no reply" };
  };
  const state = () => [...frames].reverse().find((f) => f.type === "cf_agent_state")?.state ?? null;

  // get_started is the only place a session id comes from now.
  const rules = await mcp(token, "get_started");
  const A = /session_id: use (tasks-[a-z0-9]{8})\./.exec(rules.text)?.[1];
  const B = /session_id: use (tasks-[a-z0-9]{8})\./.exec((await mcp(token, "get_started")).text)?.[1];
  check("get_started hands the agent a session id to claim with", [!rules.isError, !!A], [true, true]);
  check("a second agent gets a different one", !!B && A !== B);
  check("the rules don't send the agent looking for a hook's line, a hostname, or a folder", /Tasks session id:|Sessions hooks|hostname|machine:|project:/.test(rules.text), false);

  const added = await mcp(token, "add_cards", { lane: "To do", cards: [{ title: "Rate limit search", tags: ["agent"] }, { title: "Write the release notes", tags: ["agent"] }] });
  const [one, two] = /New card ids, in the order given: (.+)/.exec(added.text)?.[1].split(", ") ?? [];
  check("the agent adds two cards", [added.isError, !!one, !!two], [false, true, true]);

  const claimed = await mcp(token, "claim_card", { id: one, session_id: A, agent: "codex" });
  check("the first agent claims a card", [claimed.isError, claimed.text.includes(`for session ${A}`)], [false, true]);
  const refused = await mcp(token, "claim_card", { id: one, session_id: B, agent: "cursor" });
  check("a second agent is refused the claimed card", refused.isError, true);
  check("the refusal names the holder: what it is, when it was heard from, and its session", new RegExp(`already claimed by codex, heard from \\d+s ago \\(session ${A}\\)`).test(refused.text), true);
  check("the refusal says nothing of a machine, a folder, or a state", / on | in |working|idle|needs input/.test(refused.text.split("already claimed by")[1] ?? ""), false);
  // An agent whose prompt predates this still sends machine and project. They're ignored, not an error.
  const stale = await mcp(token, "claim_card", { id: two, session_id: B, agent: "cursor", machine: "mini", project: "shop-api" });
  check("a claim that still sends machine and project goes through", stale.isError, false);
  const board = await mcp(token, "get_board", { tag: "agent" });
  const held = board.text.slice(board.text.indexOf("Claimed by a live session")).split("\n");
  check("get_board lists who holds what", [
    held.some((l) => l.includes(`[${one}]`) && l.includes(`claimed by codex, heard from`) && l.includes(`(session ${A})`)),
    held.some((l) => l.includes(`[${two}]`) && l.includes(`claimed by cursor, heard from`) && l.includes(`(session ${B})`)),
  ], [true, true]);
  check("and names no machine or folder", /mini|shop-api/.test(board.text), false);
  const again = await mcp(token, "claim_card", { id: one, session_id: A });
  check("claiming again renews the holder's own claim, and keeps the name it gave", [again.isError, (await mcp(token, "get_board", {})).text.includes(`claimed by codex, heard from`)], [false, true]);

  const asked = await mcp(token, "ask_ceo", { id: one, question: "Per API key or per IP?", options: ["Per API key", "Per IP"], recommended: 1, session_id: A });
  check("the agent asks a question on its card", [asked.isError, asked.text.includes(`Session ${A} holds this card while it waits on the owner`)], [false, true]);
  check("the card shows the question to the owner", (await (async () => { await sleep(300); return state()?.cards.find((c) => c.id === one)?.ask?.question; })()), "Per API key or per IP?");
  check("the second agent still can't take the card while it waits", (await mcp(token, "claim_card", { id: one, session_id: B })).isError, true);
  const waiting = await mcp(token, "wait_for_answer", { ids: [one], seconds: 2, session_id: A });
  check("wait_for_answer says nothing is answered yet", [waiting.isError, waiting.text.includes("Nothing is answered yet")], [false, true]);
  const hold = mcp(token, "wait_for_answer", { ids: [one], seconds: 20, session_id: A });
  await sleep(500);
  check("the owner answers with one tap", (await rpc("answerAsk", [one, { choice: 0 }])).success, true);
  const answer = await hold;
  check("wait_for_answer comes back with the answer", [answer.isError, answer.text.startsWith("ANSWERED."), answer.text.includes("Per API key")], [false, true, true]);
  check("the card is still the first agent's after the answer", (await mcp(token, "claim_card", { id: one, session_id: B })).isError, true);

  const wrong = await mcp(token, "release_card", { id: one, session_id: B });
  check("only the holder can release", wrong.text.includes("holds no claim"), true);
  const released = await mcp(token, "release_card", { id: one, session_id: A });
  check("the first agent releases the card", [released.isError, released.text], [false, `Released [${one}].`]);
  check("and now the second agent can claim it", (await mcp(token, "claim_card", { id: one, session_id: B })).isError, false);

  // A card that's done isn't claimed: the claim ends by itself, with no release.
  await mcp(token, "move_cards", { ids: [two], lane: "Done" });
  await sleep(500);
  const after = await mcp(token, "get_board", {});
  check("a card moved to Done drops its claim", after.text.slice(after.text.indexOf("Claimed by a live session")).includes(`[${two}]`), false);
  // An unclaimed card: asking with a session id claims it.
  const loose = /New card ids, in the order given: (.+)/.exec((await mcp(token, "add_cards", { lane: "To do", cards: [{ title: "Pick a queue", tags: ["agent"] }] })).text)?.[1];
  await mcp(token, "ask_ceo", { id: loose, question: "SQS or a table?", options: ["SQS", "A table"], session_id: A });
  check("asking on an unclaimed card with a session id claims it", (await mcp(token, "claim_card", { id: loose, session_id: B })).isError, true);

  // What's gone, and what old machines still get.
  const page = await call(cookie, "GET", "/presence");
  check("there's no Sessions list to fetch: /tasks/presence is a 404", page.status, 404);
  const sock = await new Promise((resolve) => {
    const s = new WebSocket(`${BASE.replace(/^http/, "ws")}/tasks/presence`, { headers: { Cookie: cookie } });
    s.on("open", () => { s.close(); resolve("opened"); });
    s.on("unexpected-response", (_r, res) => resolve(res.statusCode));
    s.on("error", () => resolve(null));
  });
  // Vite drops a refused upgrade without the status (null); the built Worker says 404.
  check("and no socket there", sock === 404 || sock === null, true);
  const hook = { session_id: `old-hook-${run}`, cwd: "/Users/someone/code/secret-project", hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: "/x/y.ts" } };
  const old = await call(null, "POST", "/api/presence", hook, { Authorization: `Bearer ${token}`, "X-Tasks-Machine": "old-mac" });
  check("an old hook still gets 200 and an empty object", [old.status, old.text, old.headers.get("x-tasks-presence")], [200, "{}", "retired"]);
  check("with a bad token it gets the 401 it always got", (await call(null, "POST", "/api/presence", hook, { Authorization: "Bearer tasks_nope" })).status, 401);
  const end = await mcp(token, "get_board", {});
  check("and nothing it sent is kept", /old-hook|secret-project|old-mac/.test(end.text), false);
  ws.close();
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
