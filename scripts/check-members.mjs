#!/usr/bin/env node
// Check team boards (// TEAM_BOARDS in the README) by attacking a running dev server. It signs
// up real accounts (a Pro owner, a writer, a viewer, a stranger, a member who gets removed, and
// a few more for invites that are revoked, expired, declined, or left), then tries every way
// in and every change each of them shouldn't be able to make: over HTTP, and over the board's
// WebSocket by speaking the Agents SDK's wire protocol directly, with no UI in the way.
//
//   npm run dev:local -- --port 5231 --strictPort     # in another terminal
//   npm run check:members                             # or: npm run check:members -- http://localhost:5173
//
// It needs a LOCAL dev server with DEV_LOGIN_CODES=1 (sign-in codes and invite links come back
// in the API response, and no email is sent), and it reads and writes the same local D1 the
// server uses, through `wrangler d1 execute --local`: to make the owner Pro the way the Stripe
// webhook would, to age an invite past 7 days, and to check that only a hash of each token is
// stored. It refuses to run against anything but localhost. One line per assertion; exits 1 on
// any failure. The plan-lapse rows wait for the board's own recheck (MEMBER_RECHECK_SECONDS,
// 30 by default), so a full run takes a minute or two.

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

const root = new URL("..", import.meta.url).pathname;
const BASE = (process.argv[2] ?? "http://localhost:5231").replace(/\/+$/, "");
const host = new URL(BASE).hostname;
if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) {
  console.error(`check:members only runs against a local dev server, not ${host}. It creates accounts and edits the local database.`);
  process.exit(2);
}
const WS_BASE = BASE.replace(/^http/, "ws");
const RECHECK_S = Number(process.env.MEMBER_RECHECK_SECONDS ?? 30);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function ok(name, cond, detail = "") {
  if (cond) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? `  (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`); }
  return !!cond;
}
const section = (t) => console.log(`\n# ${t}`);

// ---------- the pure rules ----------

const dir = join(root, "node_modules", ".cache", "check-members");
const stubs = {
  name: "stubs",
  setup(b) {
    b.onResolve({ filter: /^(cloudflare:workers|agents)$/ }, (a) => ({ path: a.path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export class DurableObject {}; export const getAgentByName = () => { throw new Error('no agents here'); };" }));
  },
};
const load = async (entry) => {
  const outfile = join(dir, `${entry.replace(/\W/g, "-")}-${process.pid}.mjs`);
  await build({ entryPoints: [join(root, entry)], outfile, bundle: true, format: "esm", platform: "node", logLevel: "error", plugins: [stubs] });
  return import(pathToFileURL(outfile).href);
};
const rules = await load("src/member-rules.ts");
const shared = await load("src/shared.ts");
const auth = await load("src/auth.ts");
const sealedLib = await load("src/sealed.ts");

section("access rules (pure)");
{
  const { decide } = rules;
  const d = (i) => decide({ isOwner: false, membership: null, plan: "pro", sealed: false, ...i });
  ok("the owner is the owner on a free plan", d({ isOwner: true, plan: "free" }).effective === "owner");
  ok("the owner is the owner on an encrypted board", d({ isOwner: true, sealed: true }).effective === "owner");
  ok("no membership is no access", d({}).effective === "none" && d({}).role === null && d({}).reason === "not_member");
  ok("a writer on a Pro board writes", d({ membership: "writer" }).effective === "writer" && d({ membership: "writer" }).reason === null);
  ok("a viewer on a Pro board views", d({ membership: "viewer" }).effective === "viewer");
  ok("a writer drops to viewer when the plan lapses", d({ membership: "writer", plan: "free" }).effective === "viewer" && d({ membership: "writer", plan: "free" }).reason === "plan_lapsed" && d({ membership: "writer", plan: "free" }).role === "writer");
  ok("a viewer stays a viewer when the plan lapses", d({ membership: "viewer", plan: "free" }).effective === "viewer");
  ok("an encrypted board is closed to members", d({ membership: "writer", sealed: true }).effective === "none" && d({ membership: "writer", sealed: true }).reason === "encrypted");
  ok("a role that isn't viewer or writer is no access", d({ membership: "owner" }).effective === "none" && d({ membership: "admin" }).effective === "none");

  const { memberCallNeeds } = rules;
  ok("search is the one thing a viewer may call", Object.entries(rules.MEMBER_CALLS).filter(([, r]) => r === "viewer").map(([k]) => k).join() === "search");
  ok("writers get card actions only", Object.keys(rules.MEMBER_CALLS).sort().join() === "addCard,applyLocal,deleteCard,moveCard,removeAttachment,search,updateCard");
  ok("an unlisted method is the owner's", memberCallNeeds("addLane") === null && memberCallNeeds("undo") === null && memberCallNeeds("answerAsk") === null && memberCallNeeds("setTheme") === null);
  ok("prototype names aren't methods", memberCallNeeds("constructor") === null && memberCallNeeds("__proto__") === null && memberCallNeeds("toString") === null && memberCallNeeds("hasOwnProperty") === null && memberCallNeeds(7) === null);

  const { memberChangeError, assertMayChange } = rules;
  let b = shared.newBoard();
  b = shared.addCard(b, { title: "One" }).board;
  const card = b.cards[0];
  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  ok("a writer may add a card", memberChangeError(b, shared.addCard(b, { title: "Two" }).board) === null);
  ok("a writer may edit a card", memberChangeError(b, shared.updateCard(b, card.id, { title: "Uno", notes: "- [x] done", tags: ["x"] })) === null);
  ok("a writer may move a card", memberChangeError(b, shared.moveCard(b, card.id, b.lanes[1].id, 0)) === null);
  ok("a writer may delete a card", memberChangeError(b, shared.deleteCards(b, [card.id])) === null);
  ok("a writer may not add a lane", memberChangeError(b, shared.addLane(b, "Later").board) !== null);
  ok("a writer may not rename a lane", memberChangeError(b, shared.renameLane(b, b.lanes[0].id, "Inbox")) !== null);
  ok("a writer may not delete a lane", memberChangeError(b, shared.deleteLane(b, b.lanes[1].id)) !== null);
  ok("a writer may not reorder lanes", memberChangeError(b, shared.moveLane(b, b.lanes[0].id, 2)) !== null);
  ok("a writer may not sort a lane", memberChangeError(b, shared.setLaneSort(b, b.lanes[0].id, "title")) !== null);
  ok("a writer may not change a lane's role", memberChangeError(b, shared.setLaneRole(b, b.lanes[0].id, "done")) !== null);
  ok("a writer may not change the theme", memberChangeError(b, { ...b, theme: "x", themeChosen: true }) !== null);
  ok("a writer may not add a setting", memberChangeError(b, { ...b, agentSeenAt: "2026-01-01" }) !== null && memberChangeError(b, { ...b, sealed: { v: 1, kid: "k", envelope: "e", since: "s" } }) !== null);
  const asked = shared.askCard(b, card.id, { question: "Ship?", options: ["Yes", "No"] });
  ok("a writer may not put a question on a card", memberChangeError(b, asked) !== null);
  ok("a writer may not answer a question", memberChangeError(asked, shared.answerAsk(asked, card.id, { choice: 0 })) !== null);
  ok("a writer may not take a question back by untagging", memberChangeError(asked, shared.updateCard(asked, card.id, { tags: [] })) !== null);
  ok("a writer may not delete a card with an open question", memberChangeError(asked, shared.deleteCards(asked, [card.id])) !== null);
  ok("a writer may not finish a card with an open question", memberChangeError(asked, shared.moveCard(asked, card.id, shared.doneLaneId(asked.lanes), 0)) !== null);
  ok("a writer may still edit the notes of a card with a question", memberChangeError(asked, shared.updateCard(asked, card.id, { notes: "more" })) === null);
  const answered = shared.answerAsk(asked, card.id, { choice: 0 });
  ok("a writer may not rewrite the owner's answer", memberChangeError(answered, { ...answered, cards: answered.cards.map((c) => ({ ...c, answer: { ...c.answer, answer: "No" } })) }) !== null);
  ok("a viewer may change nothing", throws(() => assertMayChange("viewer", null, b, shared.addCard(b, { title: "Two" }).board)));
  ok("no access may change nothing", throws(() => assertMayChange("none", "not_member", b, shared.addCard(b, { title: "Two" }).board)));
  ok("the owner may change lanes", !throws(() => assertMayChange("owner", null, b, shared.addLane(b, "Later").board)));
  ok("a writer's card change passes the guard", !throws(() => assertMayChange("writer", null, b, shared.addCard(b, { title: "Two" }).board)));
  ok("a writer's lane change fails the guard", throws(() => assertMayChange("writer", null, b, shared.addLane(b, "Later").board)));

  const { inviteEmail } = rules;
  ok("invite emails are lower-cased and trimmed", inviteEmail("  Ana@Example.COM ") === "ana@example.com");
  ok("plus addressing is kept, not folded", inviteEmail("ana+work@example.com") === "ana+work@example.com");
  ok("a look-alike letter is refused", inviteEmail("аna@example.com") === null && inviteEmail("ana@exаmple.com") === null);
  ok("not-an-email is refused", inviteEmail("ana") === null && inviteEmail("ana@") === null && inviteEmail("a b@example.com") === null && inviteEmail(null) === null && inviteEmail("ana@example") === null);

  // What a member may grow the board to, checked on the result of every change they make.
  const L = rules.MEMBER_LIMITS;
  const withCard = (patch) => ({ ...b, cards: b.cards.map((c) => (c.id === card.id ? { ...c, ...patch } : c)) });
  const code = (m) => rules.errorCode(m ?? "");
  ok("a member's title is held to 200 characters", memberChangeError(b, withCard({ title: "t".repeat(L.title) })) === null && code(memberChangeError(b, withCard({ title: "t".repeat(L.title + 1) }))) === "too_big");
  ok("a member's notes are held to 4,000 characters", memberChangeError(b, withCard({ notes: "n".repeat(L.notes) })) === null && code(memberChangeError(b, withCard({ notes: "n".repeat(L.notes + 1) }))) === "too_big");
  ok("a member's tags are held to 10 of 32 characters", memberChangeError(b, withCard({ tags: Array.from({ length: L.tags }, (_, i) => `t${i}`) })) === null
    && code(memberChangeError(b, withCard({ tags: Array.from({ length: L.tags + 1 }, (_, i) => `t${i}`) }))) === "too_big" && code(memberChangeError(b, withCard({ tags: ["x".repeat(L.tag + 1)] }))) === "too_big");
  ok("a member's due date has to be a date", code(memberChangeError(b, withCard({ due: "x".repeat(500) }))) === "too_big" && memberChangeError(b, withCard({ due: "2026-10-04" })) === null);
  // Text that looks encrypted skips the trimming every edit gets (tidy in shared.ts). The guard checks the result instead.
  const sealedLooking = `eyJhbGciOiJkaXIifQ..${"A".repeat(16)}.${"B".repeat(20_000)}.${"C".repeat(22)}`;
  const viaOps = shared.updateCard(b, card.id, { title: sealedLooking });
  ok("text dressed up as ciphertext doesn't get a member past the limits", viaOps.cards[0].title.length > 20_000 && code(memberChangeError(b, viaOps)) === "too_big" && code(memberChangeError(b, shared.updateCard(b, card.id, { notes: sealedLooking }))) === "too_big");
  ok("a card the member didn't touch isn't measured", memberChangeError(withCard({ notes: "n".repeat(9000) }), shared.addCard(withCard({ notes: "n".repeat(9000) }), { title: "Two" }).board) === null);
  const many = (n, notes = "") => ({ ...b, cards: Array.from({ length: n }, (_, i) => ({ ...card, id: `c${i}`, notes })) });
  const full = many(L.cards);
  ok(`a member can't add a card past ${L.cards}`, memberChangeError(many(L.cards - 1), shared.addCard(many(L.cards - 1), { title: "last" }).board) === null && code(memberChangeError(full, shared.addCard(full, { title: "one more" }).board)) === "board_full");
  ok("on a full board a member can still edit, move, and delete", memberChangeError(full, shared.updateCard(full, "c1", { title: "edited" })) === null && memberChangeError(full, shared.moveCard(full, "c1", full.lanes[1].id, 0)) === null && memberChangeError(full, shared.deleteCards(full, ["c1"])) === null);
  const heavy = many(300, "n".repeat(3600));
  ok("a member can't grow a board past 1 MB", JSON.stringify(heavy).length > L.boardBytes && code(memberChangeError(heavy, shared.addCard(heavy, { title: "more" }).board)) === "board_full" && code(memberChangeError(heavy, shared.updateCard(heavy, "c1", { notes: "n".repeat(3700) }))) === "board_full");
  ok("and can still shrink one that's over", memberChangeError(heavy, shared.deleteCards(heavy, ["c1"])) === null && memberChangeError(heavy, shared.updateCard(heavy, "c1", { notes: "short" })) === null);
  ok("the owner isn't held to a member's limits", !throws(() => assertMayChange("owner", null, full, shared.addCard(full, { title: "one more" }).board)));

  // The token bucket every member frame is charged to.
  const { spendToken, MEMBER_RATE: R } = rules;
  let bucket; let passed0 = 0; let refused0 = 0; let flood0 = false;
  for (let i = 0; i < R.burst + R.strikes; i++) { const r = spendToken(bucket, 1000); bucket = r.bucket; if (r.ok) passed0++; else refused0++; flood0 = r.flood; }
  ok(`a burst gets ${R.burst} frames through and the rest are refused`, passed0 === R.burst && refused0 === R.strikes);
  ok(`${R.strikes} refusals in a row is a flood`, flood0 === true);
  ok(`the bucket refills at ${R.perSecond} a second`, spendToken({ ...bucket }, 2000).ok === true && (() => { let b2 = { ...bucket }; let n = 0; for (let i = 0; i < 20; i++) { const r = spendToken(b2, 2000); b2 = r.bucket; if (r.ok) n++; } return n; })() === R.perSecond);
  ok("a member who goes quiet is forgiven", (() => { const r = spendToken({ ...bucket }, 1000 + (R.burst / R.perSecond) * 1000 + 1); return r.ok && r.bucket.strikes === 0; })());
  ok("an error's code comes off before a person reads it", rules.plainError(rules.SLOW_DOWN).startsWith("Slow down.") && rules.errorCode(rules.SLOW_DOWN) === "slow_down" && rules.plainError("No code here") === "No code here");

  const by = { email: "w@example.com" };
  const b2 = shared.addCard(b, { title: "Two" }).board;
  const stamped = shared.stampBy(b, b2, by);
  ok("a new card is marked with who added it", stamped.cards.find((c) => c.title === "Two").by.email === "w@example.com");
  ok("an untouched card isn't marked", stamped.cards.find((c) => c.title === "One").by === undefined);
  const forged = { ...b, cards: b.cards.map((c) => ({ ...c, by: { email: "owner@example.com" } })) };
  ok("a mark that came in with an unchanged card is dropped", shared.stampBy(b, forged, by).cards[0].by === undefined);
  const edited = { ...b, cards: b.cards.map((c) => ({ ...c, title: "Uno", by: { email: "owner@example.com" } })) };
  ok("a mark that came in with a changed card is replaced", shared.stampBy(b, edited, by).cards[0].by.email === "w@example.com");
  ok("with nobody to name, a changed card loses its old mark", shared.stampBy(stamped, { ...stamped, cards: stamped.cards.map((c) => ({ ...c, notes: "x" })) }, null).cards.every((c) => c.by === undefined));
  ok("a mark doesn't change the board's shape", shared.sameShape(b2, stamped));

  // The invite page signs people in with next=/tasks/invite and keeps the token in the tab.
  // If a page ever did put the link's fragment in `next`, it's cut before `next` reaches the
  // sign-in email or the SSO redirect.
  ok("next= takes the invite page, and never its token", auth.safeNext("/tasks/invite") === "/tasks/invite" && auth.safeNext("/tasks/invite#t=SECRET") === "/tasks/invite" && auth.safeNext("/tasks/?board=abc#t=SECRET") === "/tasks/?board=abc" && auth.safeNext("#/tasks/") === null);
  ok("next= refuses other sites", auth.safeNext("//evil.example/tasks/") === null && auth.safeNext("https://evil.example/tasks/") === null && auth.safeNext("/tasksevil") === null && auth.safeNext("/tasks/\\evil.example") === null);
  const db = (row) => ({ prepare: () => ({ bind: () => ({ first: async () => row }) }) });
  ok("ALLOWED_EMAILS still refuses an address nobody invited", (await auth.maySignIn({ ALLOWED_EMAILS: "boss@example.com", DB: db(null) }, "new@example.com")) === false);
  ok("ALLOWED_EMAILS lets an invited address sign in", (await auth.maySignIn({ ALLOWED_EMAILS: "boss@example.com", DB: db({ ok: 1 }) }, "new@example.com")) === true);
  ok("ALLOWED_EMAILS still lets a listed address in", (await auth.maySignIn({ ALLOWED_EMAILS: "boss@example.com", DB: db(null) }, "boss@example.com")) === true);
}

// ---------- talking to the server ----------

function d1(sql) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "todo-agent-auth", "--local", "--json", "--command", sql],
    { cwd: root, timeout: 90_000, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  return JSON.parse(out.slice(out.indexOf("[")))[0].results;
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function call(who, method, path, body, headers = {}) {
  const r = await fetch(`${BASE}/tasks${path}`, {
    method,
    headers: { ...(who?.cookie ? { Cookie: who.cookie } : {}), ...(body !== undefined && !(body instanceof Uint8Array) ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
    redirect: "manual",
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, data, text, headers: r.headers };
}

const run = randomBytes(4).toString("hex");
async function account(name) {
  const email = `tb-${name}-${run}@example.com`;
  const start = await call(null, "POST", "/api/auth/start", { email, turnstile: "XXXX.DUMMY.TOKEN.XXXX" });
  if (!start.data?.devCode) throw new Error(`No dev sign-in code for ${email}: is this a dev server with DEV_LOGIN_CODES=1? ${start.status} ${start.text.slice(0, 200)}`);
  const verify = await call(null, "POST", "/api/auth/verify", { email, code: start.data.devCode });
  const cookie = (verify.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie.startsWith("sid=")) throw new Error(`Sign-in failed for ${email}: ${verify.status} ${verify.text.slice(0, 200)}`);
  const me = await call({ cookie }, "GET", "/api/me");
  return { name, email, cookie, id: me.data.id };
}

// The board charges every frame a member sends to a token bucket (MEMBER_RATE in
// src/member-rules.ts). This script sends them faster than a person could, so it keeps the same
// count, a little on the safe side, and waits when it would run dry. The flood section goes
// around it on purpose.
const pacers = new Map();
async function pace(who, n = 1) {
  if (!who?.id) return;
  const { burst, perSecond } = rules.MEMBER_RATE;
  const p = pacers.get(who.id) ?? { tokens: burst - 6, at: Date.now() };
  pacers.set(who.id, p);
  for (;;) {
    const now = Date.now();
    p.tokens = Math.min(burst - 6, p.tokens + ((now - p.at) / 1000) * perSecond * 0.9);
    p.at = now;
    if (p.tokens >= n) { p.tokens -= n; return; }
    await sleep(Math.ceil(((n - p.tokens) / (perSecond * 0.9)) * 1000) + 20);
  }
}

/** Open the board socket and keep every frame. Resolves either way; `status` is the HTTP status of a refused upgrade. */
async function open(who, { board, path = "/agent", headers = {}, extra = "", unpaced = false } = {}) {
  const member = !!board && !!who && board !== who.id && !unpaced;
  if (member) await pace(who);
  return new Promise((resolve) => {
    const url = `${WS_BASE}/tasks${path}?_pk=${randomBytes(6).toString("hex")}${board ? `&board=${board}` : ""}${extra}`;
    const ws = new WebSocket(url, { headers: { ...(who?.cookie ? { Cookie: who.cookie } : {}), ...headers }, handshakeTimeout: 15_000 });
    const frames = [];
    let bytes = 0;
    let wake = [];
    const poke = () => { const w = wake; wake = []; for (const f of w) f(); };
    let done = false;
    const sock = {
      ws, frames, status: null, closed: null, closedAt: null, opened: false,
      get bytes() { return bytes; },
      /** The first frame matching `pred`, already seen or arriving within `ms`. Null on timeout. */
      async wait(pred, ms = 5000, from = 0) {
        const end = Date.now() + ms;
        for (;;) {
          const hit = frames.slice(from).find(pred);
          if (hit) return hit;
          const left = end - Date.now();
          if (left <= 0) return null;
          await Promise.race([new Promise((r) => wake.push(r)), sleep(left)]);
        }
      },
      async waitClosed(ms = 5000) {
        const end = Date.now() + ms;
        while (!sock.closed && Date.now() < end) await Promise.race([new Promise((r) => wake.push(r)), sleep(100)]);
        return sock.closed;
      },
      send(frame) { try { ws.send(typeof frame === "string" ? frame : JSON.stringify(frame)); return true; } catch { return false; } },
      /** Call a method the way the SDK's client does. */
      async rpc(method, args = [], ms = 8000) {
        if (member) await pace(who);
        const id = randomBytes(6).toString("hex");
        const from = frames.length;
        if (!sock.send({ type: "rpc", id, method, args })) return { success: false, error: "socket closed", closed: true };
        const r = await sock.wait((f) => f.type === "rpc" && f.id === id, ms, from);
        return r ?? { success: false, error: "no reply", timeout: true };
      },
      state() { return [...frames].reverse().find((f) => f.type === "cf_agent_state")?.state ?? null; },
      access() { return [...frames].reverse().find((f) => f.type === "tasks_access") ?? null; },
      close() { try { ws.close(); } catch { /* gone */ } },
    };
    const finish = () => { if (!done) { done = true; resolve(sock); } };
    ws.on("open", () => { sock.opened = true; finish(); });
    ws.on("message", (d) => {
      bytes += d.length;
      let f; try { f = JSON.parse(d.toString()); } catch { f = { raw: d.toString() }; }
      // When it arrived, kept off to the side so comparing frames as JSON still works.
      if (f && typeof f === "object") Object.defineProperty(f, "_at", { value: Date.now(), enumerable: false });
      frames.push(f); poke();
    });
    ws.on("unexpected-response", (_req, res) => { sock.status = res.statusCode; res.resume(); finish(); });
    ws.on("error", () => finish());
    ws.on("close", (code, reason) => { sock.closed = { code, reason: reason.toString() }; sock.closedAt = Date.now(); poke(); finish(); });
  });
}

/** One MCP tool call over Streamable HTTP with a personal access token. Returns the text of the result. */
async function mcp(token, name, args = {}, extra = "") {
  const r = await fetch(`${BASE}/tasks/mcp${extra}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  const payload = text.includes("data:") ? text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("") : text;
  let data = null;
  try { data = JSON.parse(payload); } catch { /* leave it */ }
  const out = (data?.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { status: r.status, isError: !!data?.result?.isError || !!data?.error, text: out, raw: text };
}

// A dev server (vite) drops the connection on a refused upgrade without passing the status on;
// the built Worker answers with it. Either way the socket never opens. When the status does
// come through, it has to be the one expected.
const refused = (sock, status) => !sock.opened && (sock.status === null || sock.status === status);
const how = (sock) => `opened=${sock.opened} status=${sock.status} closed=${JSON.stringify(sock.closed)}`;

const invite = (owner, email, role) => call(owner, "POST", "/api/board/invites", { email, role });
const tokenOf = (res) => new URL(res.data?.devLink ?? "http://x/#t=").hash.slice(3);
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const makePro = (u) => d1(`INSERT INTO subscriptions (user_id, email, customer_id, subscription_id, status, current_period_end, cancel_at_period_end, updated_at)
  VALUES (${q(u.id)}, ${q(u.email)}, ${q(`cus_check_${run}_${u.name}`)}, ${q(`sub_check_${run}_${u.name}`)}, 'active', ${Math.floor(Date.now() / 1000) + 30 * 86400}, 0, ${Date.now()})
  ON CONFLICT(user_id) DO UPDATE SET status = 'active', current_period_end = excluded.current_period_end, updated_at = excluded.updated_at`);
const audit = async (owner) => (await call(owner, "GET", "/api/board/audit?limit=200")).data?.entries ?? [];
const has = (entries, action, target, more = {}) => entries.some((e) => e.action === action && (target === undefined || e.target === target) && Object.entries(more).every(([k, v]) => e[k] === v));

// ---------- setup ----------

section("setup");
// The sign-in and invite-link limits count by IP, and locally every request is one IP. Start clean.
d1("DELETE FROM login_limits WHERE key LIKE 'ip:%' OR key LIKE 'invite-%'");
const owner = await account("owner");
const writer = await account("writer");
const viewer = await account("viewer");
const stranger = await account("stranger");
const removed = await account("removed");
const leaver = await account("leaver");
const revoked = await account("revoked");
const late = await account("late");
const decliner = await account("decliner");
const encOwner = await account("enc");
// A board of their own for the flood section, so nothing it does lands on the board above.
const floodOwner = await account("floodowner");
const flooder = await account("flooder");
const watcher = await account("watcher");
ok("thirteen accounts signed in", [owner, writer, viewer, stranger, removed, leaver, revoked, late, decliner, encOwner, floodOwner, flooder, watcher].every((u) => /^[0-9a-f]{32}$/.test(u.id)));

// ---------- a WebSocket upgrade anywhere but the three socket addresses ----------

section("stray WebSocket upgrades");
{
  // An upgrade to a page, a file, an API route, or the Agents SDK's own address shape once took
  // the whole dev server down, signed out. Each must be refused, and the server must still answer.
  const alive = async () => { try { return (await call(null, "GET", "/api/me")).status === 200; } catch { return false; } };
  const hex = randomBytes(16).toString("hex");
  const stray = [
    `/tasks/agents/todo-agent/${owner.id}`, `/tasks/agents/todo-agent/${hex}`, `/agents/todo-agent/${owner.id}`,
    `/tasks/agent/sub/todo-agent/${owner.id}`, `/tasks/agent/`, "/tasks/", "/tasks", "/tasks/connect", "/tasks/invite", "/tasks/nope",
    "/tasks/assets/nope.js", "/tasks/og.png", "/tasks/api/me", "/tasks/api/board/members", "/tasks/mcp", "/tasks/setup.mjs",
    "/tasks/oauth/token", "/tasks/presence/x", "/tasks/events/x", "/", "/.well-known/oauth-authorization-server",
  ];
  for (const who of [null, owner, stranger]) {
    let bad = [];
    for (const path of stray) {
      const s = await new Promise((resolve) => {
        const ws = new WebSocket(`${WS_BASE}${path}`, { headers: who ? { Cookie: who.cookie } : {}, handshakeTimeout: 10_000 });
        ws.on("open", () => { ws.close(); resolve({ opened: true }); });
        ws.on("unexpected-response", (_r, res) => { res.resume(); resolve({ opened: false, status: res.statusCode }); });
        ws.on("error", () => resolve({ opened: false, status: null }));
      });
      // Vite drops a refused upgrade without the status; the built Worker says 404.
      if (s.opened || (s.status !== null && s.status !== 404) || !(await alive())) bad.push([path, s]);
    }
    ok(`${who ? (who === owner ? "signed in" : "signed in as someone else") : "signed out"}, an upgrade to ${stray.length} addresses that aren't sockets is refused and the server stays up`, bad.length === 0, bad);
  }
  const real = await open(owner);
  ok("the board's own socket still opens", real.opened && !!(await real.wait((f) => f.type === "cf_agent_state")), how(real));
  real.close();
}

// ---------- invites ----------

section("invites");
{
  const free = await invite(owner, writer.email, "writer");
  ok("a free owner can't invite: 402 pro_required", free.status === 402 && free.data?.code === "pro_required", free);
  const list0 = await call(owner, "GET", "/api/board/members");
  ok("a free owner's members list says sharing needs Pro", list0.status === 200 && list0.data.board.sharing === "pro_required" && list0.data.members.length === 0, list0.data);
  makePro(owner);
  ok("you can't invite yourself", (await invite(owner, owner.email, "writer")).data?.code === "self");
  ok("a role that isn't viewer or writer is refused", (await invite(owner, writer.email, "owner")).data?.code === "bad_role");
  ok("a look-alike address is refused", (await invite(owner, `tb-writеr-${run}@example.com`, "writer")).data?.code === "bad_email");
  ok("an invite needs a session", (await call(null, "POST", "/api/board/invites", { email: writer.email, role: "writer" })).status === 401);
  const cross = await call(owner, "POST", "/api/board/invites", { email: writer.email, role: "writer" }, { Origin: "https://evil.example" });
  ok("an invite posted from another origin is refused", cross.status === 403, cross.status);

  const w = await invite(owner, writer.email.toUpperCase(), "writer");
  const wToken = tokenOf(w);
  ok("a Pro owner invites a writer", w.status === 201 && w.data.member.status === "pending" && w.data.member.email === writer.email && wToken.length === 43, w);
  ok("the invite expires in 7 days", Math.abs(w.data.member.expiresAt - Date.now() - 7 * 86400_000) < 60_000);
  const rows = d1(`SELECT * FROM board_members WHERE owner_id = ${q(owner.id)}`);
  ok("only a hash of the token is stored", rows.length === 1 && rows[0].token_hash === sha256(`invite:${wToken}`) && !JSON.stringify(rows).includes(wToken), rows);
  ok("the token isn't in the audit log either", !JSON.stringify(d1(`SELECT * FROM board_audit WHERE owner_id = ${q(owner.id)}`)).includes(wToken));

  ok("signed out, the invite can't be looked up", (await call(null, "POST", "/api/invites/lookup", { token: wToken })).status === 401);
  ok("signed out, the invite can't be accepted", (await call(null, "POST", "/api/invites/accept", { token: wToken })).status === 401);
  const wrong = await call(stranger, "POST", "/api/invites/lookup", { token: wToken });
  const bogus = await call(stranger, "POST", "/api/invites/lookup", { token: randomBytes(32).toString("base64url") });
  ok("another account can't look the invite up", wrong.status === 404 && wrong.data?.code === "invite_invalid" && !wrong.text.includes(owner.email), wrong);
  ok("a wrong account and a made-up token get the same answer", wrong.status === bogus.status && wrong.text === bogus.text);
  ok("another account can't accept it", (await call(stranger, "POST", "/api/invites/accept", { token: wToken })).status === 404);
  ok("another account can't decline it", (await call(stranger, "POST", "/api/invites/decline", { token: wToken })).status === 404);
  ok("the owner can't accept their own invite", (await call(owner, "POST", "/api/invites/accept", { token: wToken })).status === 404);

  const pendingSock = await open(writer, { board: owner.id });
  const strangerSock = await open(stranger, { board: owner.id });
  const nowhere = await open(stranger, { board: randomBytes(16).toString("hex") });
  const garbage = await open(stranger, { board: "../../etc/passwd" });
  ok("a pending invitee can't connect to the board", refused(pendingSock, 404), how(pendingSock));
  ok("a stranger can't connect to the board", refused(strangerSock, 404), how(strangerSock));
  ok("a board that doesn't exist answers the same as one you're not on", refused(nowhere, 404) && refused(garbage, 404) && nowhere.status === strangerSock.status && garbage.status === strangerSock.status && nowhere.status === pendingSock.status && JSON.stringify(nowhere.frames) === JSON.stringify(strangerSock.frames), [how(nowhere), how(garbage)]);

  const seen = await call(writer, "POST", "/api/invites/lookup", { token: wToken });
  ok("the invited account sees who invited them and the role", seen.status === 200 && seen.data.invite.ownerEmail === owner.email && seen.data.invite.role === "writer" && seen.data.invite.board === owner.id, seen);
  const acc = await call(writer, "POST", "/api/invites/accept", { token: wToken });
  ok("the invited account accepts", acc.status === 200 && acc.data.board.id === owner.id && acc.data.board.role === "writer", acc);
  ok("the token is gone once it's used", d1(`SELECT token_hash FROM board_members WHERE owner_id = ${q(owner.id)}`)[0].token_hash === null);
  ok("the invite doesn't work twice", (await call(writer, "POST", "/api/invites/accept", { token: wToken })).status === 404);
  ok("a used invite can't be declined", (await call(writer, "POST", "/api/invites/decline", { token: wToken })).status === 404);

  // Opening the invite email again. The member it let in is told they're already on the board;
  // everyone else holding the same link hears what they'd hear for a made-up one.
  const reopened = await call(writer, "POST", "/api/invites/lookup", { token: wToken });
  ok("the member who used an invite, opening it again, is told they're already on the board", reopened.status === 200 && reopened.data.member?.board === owner.id && reopened.data.member.ownerEmail === owner.email && reopened.data.member.role === "writer" && !("invite" in reopened.data), reopened);
  const usedByStranger = await call(stranger, "POST", "/api/invites/lookup", { token: wToken });
  const madeUp = await call(stranger, "POST", "/api/invites/lookup", { token: randomBytes(32).toString("base64url") });
  ok("anyone else with the used link hears the same as for a made-up one", usedByStranger.status === 404 && usedByStranger.text === madeUp.text && !usedByStranger.text.includes(owner.email), usedByStranger);
  const usedByOwner = await call(owner, "POST", "/api/invites/lookup", { token: wToken });
  ok("so does the owner, and so does nobody at all", usedByOwner.status === 404 && usedByOwner.text === madeUp.text && (await call(null, "POST", "/api/invites/lookup", { token: wToken })).status === 401);
  ok("being recognized doesn't make the link work again", (await call(writer, "POST", "/api/invites/accept", { token: wToken })).status === 404 && (await call(writer, "POST", "/api/invites/decline", { token: wToken })).status === 404
    && (await call(stranger, "POST", "/api/invites/accept", { token: wToken })).status === 404);
  const usedRow = d1(`SELECT token_hash, used_token_hash, status FROM board_members WHERE owner_id = ${q(owner.id)} AND member_email = ${q(writer.email)}`)[0];
  ok("the used link is kept only as a hash, apart from the one that opens things", usedRow.token_hash === null && usedRow.used_token_hash === sha256(`invite:${wToken}`) && usedRow.status === "accepted", usedRow);

  for (const [u, role] of [[viewer, "viewer"], [removed, "writer"], [leaver, "writer"]]) {
    const r = await invite(owner, u.email, role);
    u.inviteToken = tokenOf(r);
    const a = await call(u, "POST", "/api/invites/accept", { token: tokenOf(r) });
    ok(`${u.name} is invited as ${role} and accepts`, r.status === 201 && a.status === 200, [r.status, a.status]);
  }

  const rv = await invite(owner, revoked.email, "writer");
  const rvOut = await call(owner, "POST", "/api/board/invites/revoke", { email: revoked.email });
  ok("the owner revokes a pending invite", rv.status === 201 && rvOut.status === 200);
  ok("a revoked invite doesn't work", (await call(revoked, "POST", "/api/invites/accept", { token: tokenOf(rv) })).status === 404);
  ok("a revoked invitee can't connect", refused(await open(revoked, { board: owner.id }), 404));

  const lt = await invite(owner, late.email, "writer");
  d1(`UPDATE board_members SET expires_at = ${Date.now() - 1000} WHERE owner_id = ${q(owner.id)} AND member_email = ${q(late.email)}`);
  const ltAcc = await call(late, "POST", "/api/invites/accept", { token: tokenOf(lt) });
  ok("an invite past 7 days doesn't work", ltAcc.status === 404 && ltAcc.data?.code === "invite_invalid", ltAcc);
  ok("an expired invite can't be looked up", (await call(late, "POST", "/api/invites/lookup", { token: tokenOf(lt) })).status === 404);
  ok("an expired invitee can't connect", refused(await open(late, { board: owner.id }), 404));
  const listed = (await call(owner, "GET", "/api/board/members")).data;
  ok("the owner sees the expired invite as expired", listed.members.find((m) => m.email === late.email)?.expired === true && listed.members.find((m) => m.email === late.email)?.status === "pending", listed.members);

  const d1st = await invite(owner, decliner.email, "viewer");
  const d2nd = await call(owner, "POST", "/api/board/invites/resend", { email: decliner.email });
  ok("resend makes a new link", d2nd.status === 200 && tokenOf(d2nd).length === 43 && tokenOf(d2nd) !== tokenOf(d1st), d2nd);
  ok("the old link is dead after a resend", (await call(decliner, "POST", "/api/invites/accept", { token: tokenOf(d1st) })).status === 404);
  ok("the new link works", (await call(decliner, "POST", "/api/invites/lookup", { token: tokenOf(d2nd) })).status === 200);
  ok("the invitee declines", (await call(decliner, "POST", "/api/invites/decline", { token: tokenOf(d2nd) })).status === 200);
  ok("a declined invite doesn't work", (await call(decliner, "POST", "/api/invites/accept", { token: tokenOf(d2nd) })).status === 404);
  ok("a decliner can't connect", refused(await open(decliner, { board: owner.id }), 404));

  const again = await invite(owner, writer.email, "writer");
  ok("re-inviting a member with the same role does nothing and sends nothing", again.status === 200 && again.data.changed === false && !again.data.devLink, again);

  const before = (await call(owner, "GET", "/api/board/members")).data.board;
  const fillers = [];
  for (let i = before.used; i < before.maxMembers; i++) { const e = `tb-fill${i}-${run}@example.com`; fillers.push(e); await invite(owner, e, "viewer"); }
  const over = await invite(owner, `tb-over-${run}@example.com`, "viewer");
  ok(`the member cap holds at ${before.maxMembers}, pending included`, over.status === 409 && over.data?.code === "member_limit", over);
  for (const e of fillers) await call(owner, "POST", "/api/board/invites/revoke", { email: e });
  const day = new Date().toISOString().slice(0, 10);
  const sentRow = d1(`SELECT sent FROM invite_sends WHERE owner_id = ${q(owner.id)} AND day = ${q(day)}`)[0];
  d1(`UPDATE invite_sends SET sent = ${before.maxInvitesPerDay} WHERE owner_id = ${q(owner.id)} AND day = ${q(day)}`);
  const capped = await invite(owner, `tb-capped-${run}@example.com`, "viewer");
  const cappedResend = await call(owner, "POST", "/api/board/invites/resend", { email: late.email });
  ok("the daily invite-email cap refuses a new invite", capped.status === 429 && capped.data?.code === "invite_limit", capped);
  ok("the daily cap counts resends too", cappedResend.status === 429 && cappedResend.data?.code === "invite_limit", cappedResend);
  d1(`UPDATE invite_sends SET sent = ${sentRow.sent} WHERE owner_id = ${q(owner.id)} AND day = ${q(day)}`);

  const page = await call(null, "GET", "/invite");
  ok("the invite page is served, and kept out of search", page.status === 200 && /name="robots"[^>]*noindex/.test(page.text), page.status);
  const mine = (await call(writer, "GET", "/api/boards")).data;
  ok("the writer's board list has their own board and the shared one", mine.own.board === writer.id && mine.shared.length === 1 && mine.shared[0].board === owner.id && mine.shared[0].ownerEmail === owner.email && mine.shared[0].effective === "writer", mine);
  ok("a stranger's board list has nothing shared", (await call(stranger, "GET", "/api/boards")).data.shared.length === 0);
  const acc2 = await call(writer, "GET", `/api/board/access?board=${owner.id}`);
  ok("a member can ask what their access is", acc2.status === 200 && acc2.data.access.role === "writer" && acc2.data.access.ownerEmail === owner.email && acc2.data.access.plan === "pro", acc2);
  const acc3 = await call(stranger, "GET", `/api/board/access?board=${owner.id}`);
  const acc4 = await call(stranger, "GET", `/api/board/access?board=${randomBytes(16).toString("hex")}`);
  ok("a stranger asking about a real board and a made-up one hears the same", acc3.status === 404 && acc3.text === acc4.text, [acc3.status, acc4.status]);
}

// ---------- the board socket ----------

section("the board socket");
const ownerSock = await open(owner);
await ownerSock.wait((f) => f.type === "cf_agent_state");
const lanes = ownerSock.state().lanes;
const seed = (await ownerSock.rpc("addCard", [lanes[0].id, "Owner seed card"])).result;
// A chat transcript for the owner, so there's something a member mustn't be able to read or wipe.
await ownerSock.rpc("applyLocal", [{ text: "add a secret card", calls: [{ name: "add_cards", input: { cards: [{ title: "Owner secret plan" }] } }], engine: "needle-rs", confidence: 1 }]);
const ownerMessages = async () => (await call(owner, "GET", "/agent/get-messages")).text;
const transcript = await ownerMessages();
ok("the owner has a chat transcript to protect", transcript.includes("add a secret card"), transcript.slice(0, 120));

const writerSock = await open(writer, { board: owner.id });
const viewerSock = await open(viewer, { board: owner.id });
const removedSock = await open(removed, { board: owner.id });
// A second tab for the member who gets removed, and it never sends a frame. A socket like that
// once stayed open for ten seconds after the board closed it.
const removedQuiet = await open(removed, { board: owner.id });
const leaverSock = await open(leaver, { board: owner.id });
for (const s of [writerSock, viewerSock, removedSock, removedQuiet, leaverSock]) await s.wait((f) => f.type === "cf_agent_state");
ok("a writer connects and gets the board", writerSock.opened && writerSock.state()?.cards.some((c) => c.id === seed), writerSock.status);
ok("a viewer connects and gets the board", viewerSock.opened && viewerSock.state()?.cards.some((c) => c.id === seed), viewerSock.status);
ok("a member is told their role, the owner, and the plan", writerSock.access()?.role === "writer" && writerSock.access()?.effective === "writer" && writerSock.access()?.reason === null && writerSock.access()?.ownerEmail === owner.email && writerSock.access()?.plan === "pro" && writerSock.access()?.board === owner.id, writerSock.access());
ok("a viewer is told they're a viewer", viewerSock.access()?.role === "viewer" && viewerSock.access()?.effective === "viewer", viewerSock.access());
const memberTypes = () => [...new Set([...writerSock.frames, ...viewerSock.frames].map((f) => f.type))].sort();
ok("a member's socket gets identity, access, and state, and nothing else", memberTypes().join() === "cf_agent_identity,cf_agent_state,tasks_access", memberTypes());

{
  const spoof = { "x-tasks-member": encodeURIComponent(JSON.stringify({ id: writer.id, email: writer.email })), "x-tasks-user": owner.id, "x-tasks-email": owner.email, "x-user": owner.id, "x-cf-agents-subagent-url": `${BASE}/tasks/agent/sub/todo-agent/${owner.id}` };
  const a = await open(stranger, { headers: spoof });
  await a.wait((f) => f.type === "cf_agent_state");
  ok("spoofed owner and member headers on your own socket reach only your own board", a.opened && a.state() && !a.state().cards.some((c) => c.id === seed) && !JSON.stringify(a.frames).includes("Owner seed card"), a.status);
  a.close();
  const b = await open(stranger, { board: owner.id, headers: spoof });
  ok("spoofed headers don't get a stranger onto the board", refused(b, 404), how(b));
  const c = await open(viewer, { board: owner.id, headers: spoof });
  await c.wait((f) => f.type === "tasks_access");
  const tried = await c.rpc("addCard", [lanes[0].id, "Spoofed"]);
  ok("a viewer claiming a writer's identity in a header is still a viewer", c.access()?.effective === "viewer" && tried.success === false, tried);
  c.close();
  const sub = await open(writer, { board: owner.id, path: `/agent/sub/todo-agent/${owner.id}` });
  ok("a member can't reach a path under the board's socket", refused(sub, 404), how(sub));
  const cap = await open(viewer, { board: owner.id, extra: "&__agents_transport=capnweb" });
  await cap.wait((f) => f.type === "tasks_access");
  ok("asking for another transport gets a member the same guarded socket", cap.opened && cap.access()?.effective === "viewer" && (await cap.rpc("addLane", ["X"])).success === false);
  cap.close();
  for (const [who, label] of [[writer, "a writer"], [viewer, "a viewer"], [stranger, "a stranger"]]) {
    const r = await call(who, "GET", `/agent/get-messages?board=${owner.id}`);
    ok(`${label} can't read the owner's chat over HTTP`, r.status === 404 && !r.text.includes("secret"), r.status);
  }
  const noCookie = await open(null, { board: owner.id });
  ok("signed out, the board socket is refused", refused(noCookie, 401), how(noCookie));
  const elsewhere = await open(writer, { board: owner.id, headers: { Origin: "https://evil.example" } });
  ok("a member's socket from another origin is refused", refused(elsewhere, 403), how(elsewhere));
}

const OWNER_ONLY_CALLS = [
  ["addLane", ["Hacked"]], ["renameLane", [lanes[0].id, "Hacked"]], ["deleteLane", [lanes[1].id]], ["moveLane", [lanes[0].id, 2]],
  ["setLaneRole", [lanes[0].id, "done"]], ["setLaneManual", [lanes[0].id, [seed]]], ["setLaneSort", [lanes[0].id, "title"]], ["clearLane", [lanes[0].id]],
  ["setTheme", ["paper"]], ["undo", []], ["redo", []], ["undoRedo", []], ["usage", []], ["answerAsk", [seed, { text: "x" }]],
  ["enableEncryption", [{}]], ["ensureKeyCheck", ["x"]], ["beginDisable", [{}]], ["disableEncryption", [{}]], ["changePassphrase", [{}]], ["resetEncryptedBoard", []],
  // Not callable by anyone over the socket, and a member mustn't be the exception.
  ["attach", [seed, { id: "a0000000000000000", name: "x", size: 1, type: "text/plain", addedAt: "now" }]], ["runTool", ["add_lane", { name: "Hacked" }]],
  ["askCeo", [{ id: seed, question: "Q?", options: ["a", "b"] }]], ["mutate", ["x"]], ["setState", [{ lanes: [], cards: [], theme: "paper" }]],
  ["undoIf", [1]], ["markShared", []], ["noteCards", ["card_deleted", [{ card: "c0000", title: "Forged", lane: "To do" }], { email: "owner@example.com" }]],
  ["goneCards", [{}, {}]], ["spendDeletes", [-200]], ["logCards", []],
  ["membersChanged", []], ["sweepMembers", []], ["noteAgentSeen", []], ["collectAttachments", []], ["persistMessages", [[]]], ["destroy", []],
  ["describe", []], ["cardDetail", [seed]], ["agentQueue", []], ["hasAttachment", ["x"]], ["uploadPolicy", []], ["onChatMessage", []], ["saveMessages", [[]]],
  ["constructor", []], ["__proto__", []], ["toString", []], ["fetch", []], ["sql", []], ["schedule", [1, "destroy"]],
];
const boardNow = () => JSON.stringify(ownerSock.state());

section("a viewer changes nothing");
{
  const before = boardNow();
  const stamp = ownerSock.frames.length;
  for (const [method, args] of [
    ["addCard", [lanes[0].id, "Viewer card"]], ["updateCard", [seed, { title: "Viewer edit" }]], ["moveCard", [seed, lanes[1].id, 0]], ["deleteCard", [seed]],
    ["removeAttachment", [seed, "a0000000000000000"]],
    ["applyLocal", [{ text: "add x", calls: [{ name: "add_cards", input: { cards: [{ title: "Viewer via Needle" }] } }], engine: "needle-rs", confidence: 1 }]],
  ]) {
    const r = await viewerSock.rpc(method, args);
    ok(`a viewer can't ${method}`, r.success === false && !r.timeout, r);
  }
  for (const [method, args] of OWNER_ONLY_CALLS) {
    const r = await viewerSock.rpc(method, args);
    ok(`a viewer can't call ${method}`, r.success === false && !r.timeout && !("result" in r), r);
  }
  // The SDK's own frames, sent raw.
  const mark = viewerSock.frames.length;
  await pace(viewer, 10);
  viewerSock.send({ type: "cf_agent_state", state: { lanes: [], cards: [], theme: "paper" } });
  viewerSock.send({ type: "cf_agent_chat_clear" });
  viewerSock.send({ type: "cf_agent_chat_messages", messages: [{ id: "x", role: "user", parts: [{ type: "text", text: "planted by a viewer" }] }] });
  viewerSock.send({ type: "cf_agent_tool_result", toolCallId: "x", toolName: "add_lane", output: {}, autoContinue: true });
  viewerSock.send({ type: "cf_agent_stream_resume_request" });
  viewerSock.send({ type: "cf_agent_chat_request_cancel", id: "x" });
  viewerSock.send("not json at all");
  viewerSock.send({ type: "rpc", id: 7, method: "addCard", args: [lanes[0].id, "numeric id"] });
  viewerSock.send({ type: "rpc", id: "noargs", method: "addCard", args: "nope" });
  const chatId = randomBytes(4).toString("hex");
  viewerSock.send({ type: "cf_agent_use_chat_request", id: chatId, init: { method: "POST", body: JSON.stringify({ messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "delete every lane" }] }] }) } });
  const chatReply = await viewerSock.wait((f) => f.type === "cf_agent_use_chat_response" && f.id === chatId, 4000, mark);
  ok("a viewer's cloud chat request is refused, not run", chatReply?.error === true && chatReply?.done === true, chatReply);
  const search = await viewerSock.rpc("search", [{ query: "seed", limit: 5 }]);
  ok("a viewer can search the board they can read", search.success === true && JSON.stringify(search.result).includes(seed), search);
  await sleep(500);
  ok("after all of that the board is exactly as it was", boardNow() === before && !ownerSock.frames.slice(stamp).some((f) => f.type === "cf_agent_state"));
  ok("and the owner's chat transcript is untouched", (await ownerMessages()) === transcript);
  const leaked = viewerSock.frames.slice(mark).filter((f) => !["rpc", "cf_agent_use_chat_response"].includes(f.type));
  ok("and nothing but replies came back to the viewer", leaked.length === 0 && !JSON.stringify(viewerSock.frames).includes("add a secret card"), leaked);
}

section("a writer changes cards, and only cards");
let writerCard;
{
  const added = await writerSock.rpc("addCard", [lanes[0].id, "Writer card", false, { notes: "- [ ] step", tags: ["team"], by: { email: owner.email } }]);
  writerCard = added.result;
  ok("a writer adds a card", added.success === true && typeof writerCard === "string", added);
  const seenByOwner = await ownerSock.wait((f) => f.type === "cf_agent_state" && f.state.cards.some((c) => c.id === writerCard));
  const seenByViewer = await viewerSock.wait((f) => f.type === "cf_agent_state" && f.state.cards.some((c) => c.id === writerCard));
  ok("the owner and the viewer see it live", !!seenByOwner && !!seenByViewer);
  const card = () => ownerSock.state().cards.find((c) => c.id === writerCard);
  ok("the card says the writer made it", card().by?.email === writer.email && card().by?.via === undefined, card().by);
  const forged = await writerSock.rpc("updateCard", [writerCard, { title: "Writer card, edited", by: { email: owner.email }, updatedAt: "1999-01-01T00:00:00.000Z", ask: { question: "?", options: ["a", "b"], askedAt: "x" } }]);
  await ownerSock.wait((f) => f.type === "cf_agent_state" && f.state.cards.some((c) => c.title === "Writer card, edited"));
  ok("a writer edits a card, and can't forge who did it or when", forged.success === true && card().by?.email === writer.email && card().updatedAt > "2020" && !card().ask, card());
  ok("a writer ticks a checkbox in the notes", (await writerSock.rpc("updateCard", [writerCard, { notes: "- [x] step" }])).success === true);
  ok("a writer moves a card", (await writerSock.rpc("moveCard", [writerCard, lanes[1].id, 0])).success === true);
  ok("a writer edits the owner's card, and it's marked as theirs", (await writerSock.rpc("updateCard", [seed, { notes: "writer was here" }])).success === true
    && (await ownerSock.wait((f) => f.type === "cf_agent_state" && f.state.cards.find((c) => c.id === seed)?.by?.email === writer.email)) !== null);
  const local = await writerSock.rpc("applyLocal", [{ text: "add milk", calls: [{ name: "add_cards", input: { cards: [{ title: "Writer via Needle" }] } }], engine: "needle-rs", confidence: 1 }]);
  await ownerSock.wait((f) => f.type === "cf_agent_state" && f.state.cards.some((c) => c.title === "Writer via Needle"));
  const viaNeedle = ownerSock.state().cards.find((c) => c.title === "Writer via Needle");
  ok("a writer's in-browser assistant adds a card, marked as the assistant on their behalf", local.success === true && local.result.outcomes[0].ok === true && viaNeedle?.by?.email === writer.email && viaNeedle?.by?.via === "assistant", viaNeedle?.by);
  ok("a writer's assistant turn leaves no trace in the owner's chat", (await ownerMessages()) === transcript);
  const lanesBefore = JSON.stringify(ownerSock.state().lanes);
  for (const [name, input] of [["add_lane", { name: "Hacked" }], ["rename_lane", { lane: lanes[0].id, name: "Hacked" }], ["delete_lane", { lane: lanes[1].id }]]) {
    const r = await writerSock.rpc("applyLocal", [{ text: "do it", calls: [{ name, input }], engine: "needle-rs", confidence: 1 }]);
    ok(`a writer's assistant can't ${name}`, r.success === true && r.result.outcomes[0].ok === false, r.result?.outcomes);
  }
  const themeBefore = ownerSock.state().theme;
  for (const [method, args] of OWNER_ONLY_CALLS) {
    const r = await writerSock.rpc(method, args);
    ok(`a writer can't call ${method}`, r.success === false && !r.timeout && !("result" in r), r);
  }
  await sleep(300);
  ok("after all of that the lanes and theme are exactly as they were", JSON.stringify(ownerSock.state().lanes) === lanesBefore && ownerSock.state().theme === themeBefore);
  ok("and the owner's chat transcript is untouched", (await ownerMessages()) === transcript);
  ok("the owner can still do owner things", (await ownerSock.rpc("setLaneSort", [lanes[2].id, "title"])).success === true && (await ownerSock.rpc("setLaneSort", [lanes[2].id, null])).success === true);
  const undone = await ownerSock.rpc("undo");
  ok("the owner can undo", undone.success === true && typeof undone.result === "string", undone);
  await ownerSock.rpc("redo");
}

// ---------- who deleted it ----------

section("who deleted it");
{
  // A deleted card has no face left to show a name on, so the deletion itself is recorded.
  const entryFor = async (who, pred) => {
    for (let i = 0; i < 20; i++) { const e = (await audit(who)).find(pred); if (e) return e; await sleep(150); }
    return null;
  };
  const title = "Card the writer will delete";
  const cardId = (await writerSock.rpc("addCard", [lanes[0].id, title])).result;
  await ownerSock.wait((f) => f.type === "cf_agent_state" && f.state.cards.some((c) => c.id === cardId));
  let oMark = ownerSock.frames.length; let vMark = viewerSock.frames.length; const wMark = writerSock.frames.length;
  // Everything a client could add to the call to name someone else.
  const del = await writerSock.rpc("deleteCard", [cardId, { by: { email: owner.email }, actor: owner.email }, owner.email]);
  ok("a writer deletes a card", del.success === true, del);
  const isAbout = (f) => f.type === "tasks_activity" && f.cards?.[0]?.id === cardId;
  const oFrame = await ownerSock.wait(isAbout, 3000, oMark);
  const vFrame = await viewerSock.wait(isAbout, 3000, vMark);
  ok("the owner's open board is told who deleted it and what it was called", oFrame?.action === "card_deleted" && oFrame.by.email === writer.email && oFrame.cards[0].title === title && oFrame.cards[0].lane === lanes[0].name && oFrame.count === 1, oFrame);
  ok("and gets the undo step that brings it back", Number.isInteger(oFrame?.undo));
  ok("everyone else with the board open is told too, without an undo step", vFrame?.by.email === writer.email && vFrame.cards[0].title === title && !("undo" in vFrame), vFrame);
  const gone = await entryFor(owner, (e) => e.action === "card_deleted" && e.detail?.card === cardId);
  ok("the audit log has it: who, when, the title, and the lane", gone?.actor === writer.email && gone.detail.title === title && gone.detail.lane === lanes[0].name && gone.detail.via === undefined && Math.abs(gone.at - Date.now()) < 60_000, gone);
  ok("the name is the connection's, whatever the call claimed", gone?.actor === writer.email && !JSON.stringify(gone).includes(owner.email));

  ok("a stale undo step undoes nothing", (await ownerSock.rpc("undoIf", [oFrame.undo - 1])).result === null && !ownerSock.state().cards.some((c) => c.id === cardId));
  const wMark2 = writerSock.frames.length;
  const undone = await ownerSock.rpc("undoIf", [oFrame.undo]);
  const backState = await ownerSock.wait((f) => f.type === "cf_agent_state" && f.state.cards.some((c) => c.id === cardId), 3000, oMark);
  ok("the owner's Undo for that step brings the card back", undone.success === true && typeof undone.result === "string" && !!backState, undone);
  const back = await entryFor(owner, (e) => e.action === "card_restored" && e.detail?.card === cardId);
  ok("and that's in the log too, as the owner's undo", back?.actor === owner.email && back.detail.via === "undo" && back.detail.title === title, back);
  const wBack = await writerSock.wait((f) => f.type === "tasks_activity" && f.action === "card_restored" && f.cards?.[0]?.id === cardId, 3000, wMark2);
  ok("the writer is told the owner brought it back", wBack?.by.email === owner.email && wBack.by.via === "undo" && !("undo" in wBack), wBack);

  const viaAssistant = await writerSock.rpc("applyLocal", [{ text: "delete it", calls: [{ name: "delete_cards", input: { ids: [cardId] } }], engine: "needle-rs", confidence: 1 }]);
  const viaA = await entryFor(owner, (e) => e.action === "card_deleted" && e.detail?.card === cardId && e.detail.via === "assistant");
  ok("a card the writer's assistant deletes is logged as theirs, via the assistant", viaAssistant.result?.outcomes?.[0]?.ok === true && viaA?.actor === writer.email, viaA);

  const agentCard = (await ownerSock.rpc("addCard", [lanes[0].id, "Card the owner's agent deletes"])).result;
  const token = (await call(owner, "POST", "/api/tokens", { name: "check deletes" })).data.token;
  vMark = viewerSock.frames.length;
  const byAgent = await mcp(token, "delete_cards", { ids: [agentCard] });
  const viaM = await entryFor(owner, (e) => e.action === "card_deleted" && e.detail?.card === agentCard);
  const vAgent = await viewerSock.wait((f) => f.type === "tasks_activity" && f.cards?.[0]?.id === agentCard, 3000, vMark);
  ok("a card the owner's agent deletes over MCP is logged as the owner's, via their agent", !byAgent.isError && viaM?.actor === owner.email && viaM.detail.via === "agent" && vAgent?.by.via === "agent", [byAgent.text.slice(0, 120), viaM]);

  const ownCard = (await ownerSock.rpc("addCard", [lanes[0].id, "Card the owner deletes"])).result;
  await ownerSock.rpc("deleteCard", [ownCard]);
  const byOwner = await entryFor(owner, (e) => e.action === "card_deleted" && e.detail?.card === ownCard);
  ok("the owner's own deletions are logged the same way", byOwner?.actor === owner.email && byOwner.detail.via === undefined, byOwner);

  const csv = await call(owner, "GET", "/api/board/audit.csv");
  ok("the CSV carries the card's title and lane", csv.text.includes(`,card_deleted,,,,${cardId},${title},${lanes[0].name},`), csv.text.split("\r\n").filter((l) => l.includes("card_deleted")).slice(0, 2));
  const tricky = '=HYPERLINK("http://evil.example","x"), "quoted"';
  const trickyId = (await writerSock.rpc("addCard", [lanes[0].id, tricky])).result;
  await writerSock.rpc("deleteCard", [trickyId]);
  await entryFor(owner, (e) => e.action === "card_deleted" && e.detail?.card === trickyId);
  const csv2 = (await call(owner, "GET", "/api/board/audit.csv")).text;
  ok("a title that looks like a formula is exported as text", csv2.includes(`,"'=HYPERLINK(""http://evil.example"",""x""), ""quoted""",`), csv2.split("\r\n").filter((l) => l.includes(trickyId)));
  ok("a member can't read any of it", !(await call(writer, "GET", "/api/board/audit")).text.includes(title) && !(await call(viewer, "GET", "/api/board/audit.csv")).text.includes(title));

  // A board nobody was ever invited to keeps no such log and sends no such frame.
  const solo = await open(stranger);
  await solo.wait((f) => f.type === "cf_agent_state");
  const soloCard = (await solo.rpc("addCard", [solo.state().lanes[0].id, "Solo card"])).result;
  await solo.rpc("deleteCard", [soloCard]);
  await sleep(600);
  ok("a board that was never shared keeps no deletion log", (await audit(stranger)).length === 0 && !solo.frames.some((f) => f.type === "tasks_activity"), solo.frames.map((f) => f.type));
  solo.close();
}

// ---------- questions, MCP, the feed, presence ----------

section("questions, MCP, the event feed, presence");
{
  const ownerToken = (await call(owner, "POST", "/api/tokens", { name: "check owner" })).data.token;
  const writerToken = (await call(writer, "POST", "/api/tokens", { name: "check writer" })).data.token;
  const asked = await mcp(ownerToken, "ask_ceo", { id: seed, question: "Ship it now?", options: ["Yes", "No"], recommended: 1, session_id: `check-${run}` });
  ok("the owner's agent asks a question over MCP", asked.status === 200 && !asked.isError, asked.raw.slice(0, 200));
  const q1 = await viewerSock.wait((f) => f.type === "cf_agent_state" && f.state.cards.find((c) => c.id === seed)?.ask);
  ok("members see the question", !!q1 && writerSock.state().cards.find((c) => c.id === seed)?.ask?.question === "Ship it now?");
  ok("the question is marked as the owner's agent's", ownerSock.state().cards.find((c) => c.id === seed)?.by?.email === owner.email && ownerSock.state().cards.find((c) => c.id === seed)?.by?.via === "agent", ownerSock.state().cards.find((c) => c.id === seed)?.by);
  const doneLane = lanes.find((l) => l.role === "done")?.id ?? lanes[lanes.length - 1].id;
  for (const [what, method, args] of [
    ["answer the question", "answerAsk", [seed, { choice: 0 }]],
    ["take the question back by untagging", "updateCard", [seed, { tags: [] }]],
    ["delete the card with the question", "deleteCard", [seed]],
    ["finish the card with the question", "moveCard", [seed, doneLane, 0]],
  ]) {
    ok(`a writer can't ${what}`, (await writerSock.rpc(method, args)).success === false);
    ok(`a viewer can't ${what}`, (await viewerSock.rpc(method, args)).success === false);
  }
  const untag = await writerSock.rpc("applyLocal", [{ text: "delete it", calls: [{ name: "delete_cards", input: { ids: [seed] } }], engine: "needle-rs", confidence: 1 }]);
  ok("a writer's assistant can't delete the card with the question", untag.result?.outcomes?.[0]?.ok === false);
  ok("the question is still open", ownerSock.state().cards.find((c) => c.id === seed)?.ask?.question === "Ship it now?");
  ok("the owner answers it", (await ownerSock.rpc("answerAsk", [seed, { choice: 0 }])).success === true);
  const a1 = await viewerSock.wait((f) => f.type === "cf_agent_state" && f.state.cards.find((c) => c.id === seed)?.answer);
  ok("members see the answer", a1?.state.cards.find((c) => c.id === seed)?.answer?.answer === "Yes");

  const own = await mcp(writerToken, "get_board");
  ok("a member's token reaches only their own board over MCP", own.status === 200 && !own.text.includes("Owner seed card") && !own.text.includes("Writer card"), own.text.slice(0, 200));
  const aimed = await mcp(writerToken, "get_board", {}, `?board=${owner.id}`);
  ok("naming the owner's board on the MCP address changes nothing", !aimed.text.includes("Owner seed card"), aimed.text.slice(0, 200));
  const reach = await mcp(writerToken, "get_card", { id: seed });
  ok("a member's token can't read the owner's card by id", !reach.text.includes("Owner seed card") && !reach.text.includes("writer was here"), reach.text.slice(0, 200));
  const poke = await mcp(writerToken, "update_card", { id: seed, title: "Hacked over MCP" });
  ok("a member's token can't change the owner's card by id", poke.isError && ownerSock.state().cards.find((c) => c.id === seed)?.title === "Owner seed card", poke.text.slice(0, 200));
  const search = await mcp(writerToken, "search_cards", { query: "Owner seed card secret plan" });
  ok("a member's token can't search the owner's board", !search.text.includes("Owner seed card") && !search.text.includes("Owner secret plan"), search.text.slice(0, 200));
  ok("the owner's own MCP is unchanged", (await mcp(ownerToken, "get_board")).text.includes("Owner seed card"));

  // The event feed: the member's token, the owner's board named every way a client could.
  const feed = await new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}/tasks/events?board=${owner.id}`, ["tasks-events", writerToken], { headers: { "x-user": owner.id, "x-tasks-user": owner.id } });
    const got = [];
    ws.on("message", (d) => got.push(d.toString()));
    ws.on("open", () => setTimeout(() => { ws.close(); resolve({ opened: true, got }); }, 1500));
    ws.on("unexpected-response", (_r, res) => resolve({ opened: false, status: res.statusCode, got }));
    ws.on("error", () => resolve({ opened: false, got }));
  });
  ok("a member's token on the event feed hears only their own board", !JSON.stringify(feed.got).includes("Owner seed card") && !JSON.stringify(feed.got).includes(seed), feed.got);
  const noFeed = await new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}/tasks/events`, { headers: { Cookie: writer.cookie, "x-user": owner.id } });
    ws.on("open", () => { ws.close(); resolve("opened"); });
    ws.on("unexpected-response", (_r, res) => resolve(res.statusCode));
    ws.on("error", () => resolve(null));
  });
  ok("the event feed takes no session cookie and no x-user header", noFeed === 401 || noFeed === null, noFeed);

  // Presence: the owner has a session (it asked above). A member must not see it.
  const ownerPresence = await call(owner, "GET", "/presence");
  ok("the owner sees their own session", ownerPresence.text.includes(`check-${run}`), ownerPresence.text.slice(0, 200));
  for (const [who, label] of [[writer, "a writer"], [viewer, "a viewer"], [stranger, "a stranger"]]) {
    const r = await call(who, "GET", `/presence?board=${owner.id}`, undefined, { "x-user": owner.id, "x-tasks-user": owner.id });
    ok(`${label} can't see the owner's sessions`, r.status === 200 && !r.text.includes(`check-${run}`) && !r.text.includes("Ship it now"), r.text.slice(0, 200));
  }
  const report = await call(null, "POST", `/api/presence?board=${owner.id}`, { session_id: `intruder-${run}`, hook_event_name: "SessionStart", cwd: "/tmp/x" }, { Authorization: `Bearer ${writerToken}`, "x-user": owner.id });
  ok("a member's token reports sessions to their own board only", report.status === 200 && !(await call(owner, "GET", "/presence")).text.includes(`intruder-${run}`));
}

// ---------- attachments ----------

section("attachments");
{
  const up = async (who, extra, body = new TextEncoder().encode("hello from the check")) =>
    (extra.includes("board=") && who !== stranger && await pace(who), call(who, "POST", `/api/attachments?${extra}`, body, { "Content-Type": "text/plain", "X-Filename": "note.txt", "Content-Length": String(body.length) }));
  const ownerUp = await up(owner, `card=${seed}`);
  const fileId = ownerUp.data?.attachment?.id;
  ok("the owner attaches a file", ownerUp.status === 200 && /^a[0-9a-f]{16}$/.test(fileId ?? ""), ownerUp);
  ok("a viewer downloads it through the board", (await call(viewer, "GET", `/api/attachments/${fileId}?board=${owner.id}`)).text === "hello from the check");
  ok("a writer downloads it through the board", (await call(writer, "GET", `/api/attachments/${fileId}?board=${owner.id}`)).text === "hello from the check");
  const memberCopy = await call(viewer, "GET", `/api/attachments/${fileId}?board=${owner.id}`);
  ok("a member's copy isn't cached by the browser", memberCopy.headers.get("cache-control") === "no-store");
  ok("without naming the board, a member's own prefix has no such file", (await call(viewer, "GET", `/api/attachments/${fileId}`)).status === 404);
  const s1 = await call(stranger, "GET", `/api/attachments/${fileId}?board=${owner.id}`);
  const s2 = await call(stranger, "GET", `/api/attachments/${fileId}?board=${randomBytes(16).toString("hex")}`);
  const s3 = await call(stranger, "GET", `/api/attachments/a0123456789abcdef?board=${owner.id}`);
  ok("a stranger can't download it, and can't tell a real board or file from a made-up one", s1.status === 404 && s1.text === s2.text && s1.text === s3.text && !s1.text.includes("hello"), [s1.status, s2.status, s3.status]);
  ok("signed out, no download", (await call(null, "GET", `/api/attachments/${fileId}?board=${owner.id}`)).status === 401);
  const vUp = await up(viewer, `card=${seed}&board=${owner.id}`);
  ok("a viewer can't upload", vUp.status === 403 && vUp.data?.code === "read_only", vUp);
  ok("a stranger can't upload", (await up(stranger, `card=${seed}&board=${owner.id}`)).status === 404);
  const wUp = await up(writer, `card=${seed}&board=${owner.id}`, new TextEncoder().encode("from the writer"));
  const wFile = wUp.data?.attachment?.id;
  ok("a writer uploads to the owner's board", wUp.status === 200 && !!wFile, wUp);
  ok("the file lands under the owner's prefix, on the owner's quota", (await call(owner, "GET", `/api/attachments/${wFile}`)).text === "from the writer" && (await call(writer, "GET", `/api/attachments/${wFile}`)).status === 404);
  await ownerSock.wait((f) => f.type === "cf_agent_state" && f.state.cards.find((c) => c.id === seed)?.attachments?.some((a) => a.id === wFile));
  ok("the upload is marked as the writer's change", ownerSock.state().cards.find((c) => c.id === seed)?.by?.email === writer.email);
  ok("a writer can't make a staged upload", (await up(writer, `stage=1&board=${owner.id}`)).status === 404);
  ok("a writer can't attach to a card that isn't there", (await up(writer, `card=cnope&board=${owner.id}`)).status === 400);
  ok("a viewer can't remove a file", (await viewerSock.rpc("removeAttachment", [seed, fileId])).success === false);
  ok("a writer removes a file", (await writerSock.rpc("removeAttachment", [seed, fileId])).success === true);
  await sleep(200);
  ok("a removed file is gone for members at once", (await call(viewer, "GET", `/api/attachments/${fileId}?board=${owner.id}`)).status === 404);
  ok("the owner can still fetch it while undo could bring it back", (await call(owner, "GET", `/api/attachments/${fileId}`)).status === 200);
}

// ---------- every other /api route is your own ----------

section("everything else is your own board");
{
  const wm = await call(writer, "GET", `/api/board/members?board=${owner.id}`);
  ok("a member asking for the members list gets their own (empty) one", wm.status === 200 && wm.data.board.id === writer.id && wm.data.members.length === 0, wm.data);
  const wa = await call(writer, "GET", `/api/board/audit?board=${owner.id}`);
  ok("a member can't read the owner's audit log", wa.status === 200 && wa.data.entries.length === 0 && !wa.text.includes(owner.email), wa.text.slice(0, 200));
  const wc = await call(viewer, "GET", `/api/board/audit.csv?board=${owner.id}`);
  ok("a member can't download the owner's audit log", !wc.text.includes(owner.email) && wc.text.trim().split("\n").length === 1, wc.text.slice(0, 200));
  ok("a member can't remove another member", (await call(writer, "POST", "/api/board/members/remove", { email: viewer.email, board: owner.id })).status === 404);
  ok("a member can't change a role", (await call(viewer, "POST", "/api/board/members/role", { email: viewer.email, role: "writer", board: owner.id })).status === 404);
  ok("a member can't invite to the owner's board", (await call(writer, "POST", "/api/board/invites", { email: stranger.email, role: "writer", board: owner.id })).status === 402);
  ok("a member can't revoke the owner's invite", (await call(writer, "POST", "/api/board/invites/revoke", { email: late.email })).status === 404);
  ok("the membership API needs a session", (await call(null, "GET", "/api/board/members")).status === 401 && (await call(null, "GET", "/api/board/audit.csv")).status === 401 && (await call(null, "GET", "/api/boards")).status === 401);
  const tokens = await call(writer, "GET", "/api/tokens");
  ok("a member's token list is their own", tokens.status === 200 && tokens.data.tokens.every((t) => t.name === "check writer"));
  ok("a stranger can't leave a board they aren't on", (await call(stranger, "POST", "/api/boards/leave", { board: owner.id })).status === 404);
  const enc = await ownerSock.rpc("enableEncryption", [{}]);
  ok("a shared board can't be encrypted: [board_shared]", enc.success === false && enc.error.startsWith("[board_shared]"), enc);
}

// ---------- an encrypted board can't be shared ----------

section("an encrypted board can't be shared");
{
  makePro(encOwner);
  const s = await open(encOwner);
  await s.wait((f) => f.type === "cf_agent_state");
  const plain = s.state();
  const { boardKey, envelope } = await sealedLib.createBoardKey("correct horse battery staple");
  const sealedLanes = [];
  for (const l of plain.lanes) sealedLanes.push({ ...l, name: await sealedLib.sealText(boardKey, l.name) });
  const on = await s.rpc("enableEncryption", [{ kid: boardKey.kid, envelope, board: { ...plain, lanes: sealedLanes }, proof: await sealedLib.keyProof(boardKey) }], 20_000);
  ok("a board nobody is on can still be encrypted", on.success === true, on);
  const r = await invite(encOwner, stranger.email, "viewer");
  ok("inviting on an encrypted board is refused: board_encrypted", r.status === 409 && r.data?.code === "board_encrypted", r);
  ok("its members list says why", (await call(encOwner, "GET", "/api/board/members")).data.board.sharing === "encrypted");
  s.close();
}

// ---------- changes take hold on open sockets ----------

section("open sockets follow membership");
{
  // The owner's open tabs are told too, so Members and "Shared with N" don't wait for a poll.
  const toldOwner = async (what, act) => {
    const from = ownerSock.frames.length;
    const t0 = Date.now();
    const r = await act();
    const f = await ownerSock.wait((x) => x.type === "tasks_members", 3000, from);
    const ms = f ? f._at - t0 : null;
    ok(`the owner's open board hears about ${what} within 2 seconds`, ms !== null && ms < 2000, ms);
    return r;
  };
  const inv = await toldOwner("an invite sent from another tab", () => invite(owner, revoked.email, "viewer"));
  await toldOwner("an invite being accepted", () => call(revoked, "POST", "/api/invites/accept", { token: tokenOf(inv) }));
  await toldOwner("a member removed from another tab", () => call(owner, "POST", "/api/board/members/remove", { email: revoked.email }));
  const inv2 = await toldOwner("another invite", () => invite(owner, decliner.email, "viewer"));
  await toldOwner("an invite being declined", () => call(decliner, "POST", "/api/invites/decline", { token: tokenOf(inv2) }));

  let mark = viewerSock.frames.length;
  const up = await toldOwner("a role change", () => call(owner, "POST", "/api/board/members/role", { email: viewer.email, role: "writer" }));
  const told = await viewerSock.wait((f) => f.type === "tasks_access" && f.effective === "writer", 3000, mark);
  ok("a role change reaches the open socket", up.status === 200 && told?.role === "writer", told);
  const promoted = await viewerSock.rpc("addCard", [lanes[0].id, "Promoted viewer card"]);
  ok("the promoted viewer can write on the same socket", promoted.success === true, promoted);
  mark = viewerSock.frames.length;
  await call(owner, "POST", "/api/board/members/role", { email: viewer.email, role: "viewer" });
  const down = await viewerSock.wait((f) => f.type === "tasks_access" && f.effective === "viewer", 3000, mark);
  ok("a downgrade reaches the open socket", down?.role === "viewer", down);
  ok("the downgraded socket can't write any more", (await viewerSock.rpc("addCard", [lanes[0].id, "Too late"])).success === false);

  ok("the member to be removed can write first", (await removedSock.rpc("addCard", [lanes[0].id, "From the member about to go"])).success === true);
  mark = removedSock.frames.length;
  const quietMark = removedQuiet.frames.length;
  const tGone = Date.now();
  const gone = await call(owner, "POST", "/api/board/members/remove", { email: removed.email });
  const bye = await removedSock.wait((f) => f.type === "tasks_access" && f.effective === "none", 3000, mark);
  const closed = await removedSock.waitClosed(3000);
  const quietBye = await removedQuiet.wait((f) => f.type === "tasks_access" && f.effective === "none", 3000, quietMark);
  const quietClosed = await removedQuiet.waitClosed(3000);
  const lag = (s) => (s.closedAt === null ? null : s.closedAt - tGone);
  console.log(`     … removal: told in ${bye ? bye._at - tGone : "?"} ms, closed in ${lag(removedSock)} ms; the tab that never sent a frame: told in ${quietBye ? quietBye._at - tGone : "?"} ms, closed in ${lag(removedQuiet)} ms`);
  ok("removing a member tells their open socket why", gone.status === 200 && bye?.closed === "removed" && bye?.role === null, bye);
  ok("and closes it", closed?.code === 4403, closed);
  ok("within 2 seconds, the last frame first", lag(removedSock) !== null && lag(removedSock) < 2000 && bye._at <= removedSock.closedAt && removedSock.frames[removedSock.frames.length - 1] === bye, lag(removedSock));
  ok("their other tab, which never sent a frame, is told and closed as fast", quietBye?.closed === "removed" && quietClosed?.code === 4403 && lag(removedQuiet) < 2000, [quietClosed, lag(removedQuiet)]);
  const framesAtRemoval = removedSock.frames.length;
  const after = (await ownerSock.rpc("addCard", [lanes[0].id, "After the removal"])).result;
  await writerSock.wait((f) => f.type === "cf_agent_state" && f.state.cards.some((c) => c.id === after));
  await sleep(500);
  ok("the removed member's socket gets nothing after that", removedSock.frames.length === framesAtRemoval && !JSON.stringify(removedSock.frames).includes("After the removal"));
  ok("the removed member can't call anything on it", (await removedSock.rpc("addCard", [lanes[0].id, "Ghost"], 1500)).success === false);
  ok("the removed member can't reconnect", refused(await open(removed, { board: owner.id }), 404));
  ok("the removed member can't download files", (await call(removed, "GET", `/api/attachments/a0123456789abcdef?board=${owner.id}`)).status === 404);
  ok("the removed member's board list is empty again", (await call(removed, "GET", "/api/boards")).data.shared.length === 0);
  const oldLink = await call(removed, "POST", "/api/invites/lookup", { token: removed.inviteToken });
  const noLink = await call(removed, "POST", "/api/invites/lookup", { token: randomBytes(32).toString("base64url") });
  ok("the removed member's old invite link says nothing about the board anymore", oldLink.status === 404 && oldLink.text === noLink.text && (await call(removed, "POST", "/api/invites/accept", { token: removed.inviteToken })).status === 404, oldLink);

  mark = leaverSock.frames.length;
  const tLeft = Date.now();
  const ownerMark = ownerSock.frames.length;
  const left = await call(leaver, "POST", "/api/boards/leave", { board: owner.id });
  const heard = await ownerSock.wait((x) => x.type === "tasks_members", 3000, ownerMark);
  console.log(`     … the owner's board heard a member left in ${heard ? heard._at - tLeft : "?"} ms`);
  ok("the owner's open board hears a member left within 2 seconds", !!heard && heard._at - tLeft < 2000);
  ok("a member leaves on their own", left.status === 200, left);
  // This socket never sent a frame either.
  const leftFrame = await leaverSock.wait((f) => f.type === "tasks_access" && f.effective === "none", 3000, mark);
  const leftClosed = await leaverSock.waitClosed(3000);
  console.log(`     … leaving: told in ${leftFrame ? leftFrame._at - tLeft : "?"} ms, closed in ${leaverSock.closedAt === null ? "?" : leaverSock.closedAt - tLeft} ms`);
  ok("their open socket is told", leftFrame?.closed === "removed", how(leaverSock));
  ok("and closed within 2 seconds", leftClosed?.code === 4403 && leaverSock.closedAt - tLeft < 2000, how(leaverSock));
  const leaverFrames = leaverSock.frames.length;
  const afterLeave = (await ownerSock.rpc("addCard", [lanes[0].id, "After the leaver left"])).result;
  await writerSock.wait((f) => f.type === "cf_agent_state" && f.state.cards.some((c) => c.id === afterLeave));
  await sleep(500);
  ok("and gets nothing after that", leaverSock.frames.length === leaverFrames);
  ok("and can't call anything on it", (await leaverSock.rpc("addCard", [lanes[0].id, "Ghost"], 1500)).success === false && (await leaverSock.rpc("search", [{ query: "seed" }], 1500)).success === false);
  ok("and they can't come back without a new invite", refused(await open(leaver, { board: owner.id }), 404));
  const leftLink = await call(leaver, "POST", "/api/invites/lookup", { token: leaver.inviteToken });
  ok("the link they joined with is as dead as a made-up one", leftLink.status === 404 && leftLink.data?.code === "invite_invalid" && !("member" in (leftLink.data ?? {})), leftLink);
}

// ---------- a member who floods ----------

section("a member who floods");
{
  const { burst, perSecond, strikes } = rules.MEMBER_RATE;
  const codeOf = (r) => rules.errorCode(r?.error ?? "");
  makePro(floodOwner);
  for (const [u, role] of [[flooder, "writer"], [watcher, "viewer"]]) {
    const r = await invite(floodOwner, u.email, role);
    await call(u, "POST", "/api/invites/accept", { token: tokenOf(r) });
  }
  const fo = await open(floodOwner);
  await fo.wait((f) => f.type === "cf_agent_state");
  const lane = fo.state().lanes[0].id;
  const watch = await open(watcher, { board: floodOwner.id });
  await watch.wait((f) => f.type === "cf_agent_state");
  const w = await open(flooder, { board: floodOwner.id, unpaced: true });
  await w.wait((f) => f.type === "cf_agent_state");

  // 400 writes as fast as the socket takes them, each with the biggest notes a card holds.
  const N = 400;
  const notes = "x".repeat(4000);
  const b0 = watch.bytes; const f0 = watch.frames.length; const mark = w.frames.length; const t0 = Date.now();
  for (let i = 0; i < N; i++) w.send({ type: "rpc", id: `flood${i}`, method: "addCard", args: [lane, `flood ${i}`, false, { notes }] });
  const shut = await w.waitClosed(30_000);
  const took = (w.closedAt ?? Date.now()) - t0;
  await sleep(1000);
  const replies = w.frames.slice(mark).filter((f) => f.type === "rpc");
  const through = replies.filter((r) => r.success).length;
  const slowed = replies.filter((r) => !r.success);
  const pushes = watch.frames.slice(f0).filter((f) => f.type === "cf_agent_state").length;
  const pushed = watch.bytes - b0;
  console.log(`     … ${N} writes sent: ${through} got through, ${slowed.length} refused, socket closed after ${took} ms; a watching member was sent the board ${pushes} times, ${pushed.toLocaleString("en-US")} bytes`);
  ok(`of ${N} writes in a burst, no more than the bucket's ${burst} get through`, through > 0 && through <= burst, through);
  ok("the rest are refused with slow_down, in words a person can read", slowed.length >= strikes && slowed.every((r) => codeOf(r) === "slow_down" && rules.plainError(r.error).startsWith("Slow down.")), slowed[0]);
  ok(`a socket still flooding after ${strikes} refusals is closed (4429)`, shut?.code === 4429, shut);
  ok("the board holds what got through and nothing more", fo.state().cards.length === through, [fo.state().cards.length, through]);
  ok("a watching member was sent the board a handful of times, not once per write", pushes >= 1 && pushes <= 6 && pushed < 2_000_000, [pushes, pushed]);

  // Straight back in: the bucket is per member, not per socket, so a new socket buys nothing.
  const back = await open(flooder, { board: floodOwner.id, unpaced: true });
  const mark2 = back.frames.length;
  if (back.opened) for (let i = 0; i < 60; i++) back.send({ type: "rpc", id: `again${i}`, method: "addCard", args: [lane, `again ${i}`] });
  const shut2 = back.opened ? await back.waitClosed(10_000) : { code: 4429 };
  const through2 = back.frames.slice(mark2).filter((f) => f.type === "rpc" && f.success).length;
  ok("reconnecting doesn't refill the bucket: a few calls, then closed again", through2 <= 12 && (shut2?.code === 4429 || !back.opened), [through2, shut2, how(back)]);

  console.log(`     … waiting ${burst / perSecond + 1}s for the flooder's bucket to refill`);
  await sleep((burst / perSecond + 1) * 1000);
  pacers.delete(flooder.id);
  const calm = await open(flooder, { board: floodOwner.id });
  await calm.wait((f) => f.type === "cf_agent_state");
  const one = await calm.rpc("addCard", [lane, "After the flood"]);
  const t1 = Date.now();
  const seen = await watch.wait((f) => f.type === "cf_agent_state" && f.state.cards.some((c) => c.id === one.result), 3000);
  ok("after a quiet spell the member writes again", one.success === true, one);
  ok("and a single change still reaches other members promptly", !!seen && seen._at - t1 < 1000, seen ? seen._at - t1 : "never");

  // Size limits, live. Each is one frame, so the bucket isn't what refuses them.
  const sealedLooking = `eyJhbGciOiJkaXIifQ..${"A".repeat(16)}.${"B".repeat(6000)}.${"C".repeat(22)}`;
  const longTitle = await calm.rpc("updateCard", [one.result, { title: sealedLooking }]);
  ok("a title dressed up as ciphertext is still held to 200 characters", longTitle.success === false && codeOf(longTitle) === "too_big", longTitle);
  const longNotes = await calm.rpc("addCard", [lane, "Long notes", false, { notes: sealedLooking }]);
  ok("and notes to 4,000", longNotes.success === false && codeOf(longNotes) === "too_big", longNotes);
  ok("the card is as it was", fo.state().cards.find((c) => c.id === one.result)?.title === "After the flood");
  const big = await open(flooder, { board: floodOwner.id });
  await big.wait((f) => f.type === "cf_agent_state");
  big.send({ type: "rpc", id: "big", method: "addCard", args: [lane, "big", false, { notes: "x".repeat(40_000) }] });
  const bigShut = await big.waitClosed(5000);
  ok("a frame over 32 KB closes the socket (1009) and adds nothing", bigShut?.code === 1009 && !fo.state().cards.some((c) => c.title === "big"), bigShut);

  // The card ceiling. The owner fills the board in one step; a member can't add to it.
  const max = rules.MEMBER_LIMITS.cards;
  await fo.rpc("clearLane", [lane]);
  const batch = (from, n) => ({ name: "add_cards", input: { cards: Array.from({ length: n }, (_, i) => ({ title: `filler ${from + i}` })) } });
  const filled = await fo.rpc("applyLocal", [{ text: "fill the board", calls: [batch(0, 250), batch(250, 250), batch(500, 250), batch(750, 250)], engine: "needle-rs", confidence: 1 }], 30_000);
  await fo.wait((f) => f.type === "cf_agent_state" && f.state.cards.length === max, 10_000);
  ok(`the owner fills the board to ${max} cards`, filled.success === true && fo.state().cards.length === max, fo.state().cards.length);
  const over = await calm.rpc("addCard", [lane, "One too many"]);
  ok(`a member can't add card ${max + 1}`, over.success === false && codeOf(over) === "board_full", over);
  const bulk = await calm.rpc("applyLocal", [{ text: "add", calls: [batch(2000, 50)], engine: "needle-rs", confidence: 1 }]);
  ok("or fifty through the assistant", bulk.success === true && bulk.result.outcomes[0].ok === false, bulk.result?.outcomes);
  const victim = fo.state().cards[0].id;
  ok("a member can still delete on a full board", (await calm.rpc("deleteCard", [victim])).success === true);
  ok("and then add one", (await calm.rpc("addCard", [lane, "Fits again"])).success === true && (await calm.rpc("addCard", [lane, "Doesn't"])).success === false);
  ok("the owner can go past it", (await fo.rpc("addCard", [lane, "Owner's own"])).success === true);
  await fo.rpc("clearLane", [lane]);

  // A member's deletions are counted: each is a row in a log nothing prunes.
  const perDay = rules.MEMBER_LIMITS.deletesPerDay;
  const many = await calm.rpc("applyLocal", [{ text: "add", calls: [batch(5000, perDay + 1)], engine: "needle-rs", confidence: 1 }], 20_000);
  const ids = many.result?.outcomes?.[0]?.ids ?? [];
  const wipe = (list) => calm.rpc("applyLocal", [{ text: "delete", calls: [{ name: "delete_cards", input: { ids: list } }], engine: "needle-rs", confidence: 1 }], 20_000);
  const all = await wipe(ids);
  ok(`a member can't delete ${perDay + 1} cards in one go`, ids.length === perDay + 1 && all.result?.outcomes?.[0]?.ok === false && /a day/.test(all.result.outcomes[0].summary) && !all.result.outcomes[0].summary.startsWith("["), all.result?.outcomes);
  // One was deleted in the card-ceiling rows above.
  const most = await wipe(ids.slice(0, perDay - 1));
  const rest = await calm.rpc("deleteCard", [ids[perDay]]);
  ok(`${perDay} deletions in a day go through, and the next is refused with delete_limit`, most.result?.outcomes?.[0]?.ok === true && rest.success === false && codeOf(rest) === "delete_limit", [most.result?.outcomes, rest]);
  ok("the owner isn't counted", (await fo.rpc("clearLane", [lane])).success === true && fo.state().cards.filter((c) => c.laneId === lane).length === 0);

  // Tabs. A fifth socket for one member closes their oldest.
  const tabs = [];
  for (let i = 0; i < 4; i++) { const t = await open(watcher, { board: floodOwner.id }); await t.wait((f) => f.type === "cf_agent_state"); tabs.push(t); }
  const oldest = await watch.waitClosed(5000);
  await sleep(300);
  const stillOpen = [watch, ...tabs].filter((t) => !t.closed).length;
  ok("one member holds four sockets on a board; a fifth closes the oldest", oldest?.code === 1008 && stillOpen === 4, [oldest, stillOpen]);

  // The access check a socket remembers. A demotion the board is told about holds from the very
  // next frame; one it's never told about holds within two seconds for a socket that's sending.
  ok("the writer writes, so their access was just checked", (await calm.rpc("addCard", [lane, "Before the demotion"])).success === true);
  const told = calm.frames.length;
  const tRole = Date.now();
  await call(floodOwner, "POST", "/api/board/members/role", { email: flooder.email, role: "viewer" });
  const atOnce = await calm.rpc("addCard", [lane, "Right after the demotion"]);
  const frame = await calm.wait((f) => f.type === "tasks_access" && f.effective === "viewer", 3000, told);
  console.log(`     … demotion: told in ${frame ? frame._at - tRole : "?"} ms`);
  ok("a demotion holds on the very next frame, remembered check or not", atOnce.success === false && !!frame && frame._at - tRole < 2000, atOnce);
  await call(floodOwner, "POST", "/api/board/members/role", { email: flooder.email, role: "writer" });
  ok("promoted again, they write", (await calm.rpc("addCard", [lane, "Writer again"])).success === true);
  d1(`UPDATE board_members SET role = 'viewer' WHERE owner_id = ${q(floodOwner.id)} AND member_email = ${q(flooder.email)}`);
  const tQuiet = Date.now();
  let landed = null;
  while (Date.now() - tQuiet < 6000) {
    const r = await calm.rpc("addCard", [lane, "After a demotion nobody announced"]);
    if (!r.success) { landed = Date.now() - tQuiet; break; }
    await sleep(250);
  }
  console.log(`     … a demotion written straight to the database, no signal: refused after ${landed} ms`);
  ok("a demotion the board was never told about holds within the 2-second cache", landed !== null && landed < 2600, landed);

  for (const t of [fo, calm, back, big, w, watch, ...tabs]) t.close();
}

section("open sockets follow the owner's plan");
{
  const wait = (RECHECK_S + 15) * 1000;
  let mark = writerSock.frames.length;
  d1(`UPDATE subscriptions SET status = 'canceled', updated_at = ${Date.now()} WHERE user_id = ${q(owner.id)}`);
  console.log(`     … waiting up to ${RECHECK_S + 15}s for the board's own recheck to notice the lapsed plan`);
  const ownerMark = ownerSock.frames.length;
  const lapsed = await writerSock.wait((f) => f.type === "tasks_access" && f.reason === "plan_lapsed", wait, mark);
  const ownerHeard = await ownerSock.wait((f) => f.type === "tasks_members", 3000, ownerMark);
  ok("the owner's open board hears about the lapse in the same moment", !!lapsed && !!ownerHeard && Math.abs(ownerHeard._at - lapsed._at) < 2000, [lapsed?._at, ownerHeard?._at]);
  ok("a lapsed plan reaches the open socket with no signal at all", lapsed?.effective === "viewer" && lapsed?.role === "writer" && lapsed?.plan === "free", lapsed);
  ok("the writer is view only", (await writerSock.rpc("addCard", [lanes[0].id, "During the lapse"])).success === false);
  ok("the writer can still read", (await writerSock.rpc("search", [{ query: "seed", limit: 3 }])).success === true && writerSock.ws.readyState === WebSocket.OPEN);
  const stillThere = (await ownerSock.rpc("addCard", [lanes[0].id, "Owner during the lapse"])).result;
  ok("and still sees the board change", !!(await writerSock.wait((f) => f.type === "cf_agent_state" && f.state.cards.some((c) => c.id === stillThere))));
  ok("a writer can't upload during the lapse", (await call(writer, "POST", `/api/attachments?card=${seed}&board=${owner.id}`, new TextEncoder().encode("x"), { "Content-Type": "text/plain", "X-Filename": "x.txt", "Content-Length": "1" })).status === 403);
  const refused = await invite(owner, stranger.email, "viewer");
  ok("new invites are refused while Pro is lapsed", refused.status === 402 && refused.data?.code === "pro_required", refused);
  ok("resends are refused while Pro is lapsed", (await call(owner, "POST", "/api/board/invites/resend", { email: late.email })).status === 402);
  const list = (await call(owner, "GET", "/api/board/members")).data;
  ok("nothing was deleted: the members are all still listed", list.board.sharing === "suspended" && list.members.some((m) => m.email === writer.email && m.role === "writer") && list.members.some((m) => m.email === viewer.email), list);
  const shared = (await call(writer, "GET", "/api/boards")).data.shared[0];
  ok("the writer's board list says view only and why", shared.role === "writer" && shared.effective === "viewer" && shared.reason === "plan_lapsed", shared);
  ok("the owner can still remove and change roles while lapsed", (await call(owner, "POST", "/api/board/members/role", { email: viewer.email, role: "viewer" })).status === 200);

  mark = writerSock.frames.length;
  d1(`UPDATE subscriptions SET status = 'active', updated_at = ${Date.now()} WHERE user_id = ${q(owner.id)}`);
  console.log(`     … waiting up to ${RECHECK_S + 15}s for the recheck to notice Pro is back`);
  const back = await writerSock.wait((f) => f.type === "tasks_access" && f.effective === "writer", wait, mark);
  ok("when Pro comes back, so does the role, on the same socket", back?.reason === null && back?.plan === "pro", back);
  ok("the writer can write again", (await writerSock.rpc("addCard", [lanes[0].id, "After the lapse"])).success === true);
}

// ---------- the audit log ----------

section("the audit log");
{
  const entries = await audit(owner);
  const want = [
    ["invite_sent", writer.email, { actor: owner.email, to: "writer" }],
    ["invite_accepted", writer.email, { actor: writer.email }],
    ["invite_revoked", revoked.email, { actor: owner.email }],
    ["invite_expired", late.email, { actor: late.email }],
    ["invite_resent", decliner.email, { actor: owner.email }],
    ["invite_declined", decliner.email, { actor: decliner.email }],
    ["role_changed", viewer.email, { actor: owner.email, from: "viewer", to: "writer" }],
    ["role_changed", viewer.email, { actor: owner.email, from: "writer", to: "viewer" }],
    ["member_removed", removed.email, { actor: owner.email, from: "writer" }],
    ["member_left", leaver.email, { actor: leaver.email }],
    ["sharing_suspended", null, { actor: "system" }],
    ["sharing_restored", null, { actor: "system" }],
  ];
  for (const [action, target, more] of want) ok(`the log has ${action}${target ? ` for ${target.split("-")[1]}` : ""}`, has(entries, action, target, more), entries.filter((e) => e.action === action));
  ok("every entry says who and when", entries.length > 0 && entries.every((e) => typeof e.actor === "string" && e.actor && e.at > Date.now() - 3600_000));
  ok("an expired invite used twice is written down once", entries.filter((e) => e.action === "invite_expired" && e.target === late.email).length === 1);
  const p1 = await call(owner, "GET", "/api/board/audit?limit=3");
  const p2 = await call(owner, "GET", `/api/board/audit?limit=3&before=${p1.data.next}`);
  ok("the log pages, newest first", p1.data.entries.length === 3 && p1.data.next === p1.data.entries[2].id && p2.data.entries.length === 3 && p2.data.entries[0].id < p1.data.entries[2].id, [p1.data.next, p2.data.entries.map((e) => e.id)]);
  const csv = await call(owner, "GET", "/api/board/audit.csv");
  const lines = csv.text.trim().split("\r\n");
  ok("the owner downloads the log as CSV", csv.status === 200 && /attachment; filename="tasks-audit-.*\.csv"/.test(csv.headers.get("content-disposition") ?? "") && lines[0] === "id,time,actor,action,target,from_role,to_role,card_id,card_title,lane,via" && lines.length === entries.length + 1, [lines.length, entries.length]);
  ok("the CSV names the people and the times", csv.text.includes(`${owner.email},member_removed,${removed.email},writer,`) && /\d{4}-\d\d-\d\dT/.test(lines[1]));
  const js = await call(owner, "GET", "/api/board/audit.json");
  ok("and as JSON", js.status === 200 && js.data.owner === owner.email && js.data.entries.length === entries.length);
  const who = (await call(owner, "GET", "/api/board/members")).data.members;
  ok("the members list answers who has access right now", who.filter((m) => m.status === "accepted").map((m) => `${m.email}:${m.role}`).sort().join() === [`${viewer.email}:viewer`, `${writer.email}:writer`].sort().join(), who);
  let blocked = 0;
  for (const sql of [`UPDATE board_audit SET actor = 'nobody' WHERE owner_id = ${q(owner.id)}`, `DELETE FROM board_audit WHERE owner_id = ${q(owner.id)}`]) {
    try { d1(sql); } catch { blocked++; }
  }
  ok("the log can't be edited or deleted, even straight in the database", blocked === 2 && (await audit(owner)).length === entries.length);
  ok("a member still can't read it", !(await call(writer, "GET", "/api/board/audit")).text.includes(owner.email) && !(await call(writer, "GET", "/api/board/audit.json")).text.includes(removed.email));
}

section("what only the owner hears");
ok("no member's socket was ever told about the members list", [writerSock, viewerSock, removedSock, removedQuiet, leaverSock].every((s) => !s.frames.some((f) => f.type === "tasks_members")));
ok("a member's socket only ever got identity, access, the board, card deletions, and replies", [...new Set([writerSock, viewerSock, removedSock, removedQuiet, leaverSock].flatMap((s) => s.frames.map((f) => f.type)))].sort().join() === "cf_agent_identity,cf_agent_state,cf_agent_use_chat_response,rpc,tasks_access,tasks_activity");

for (const s of [ownerSock, writerSock, viewerSock, removedSock, removedQuiet, leaverSock]) s.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\n${failed ? "FAILED" : "passed"}: ${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
