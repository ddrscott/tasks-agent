#!/usr/bin/env node
// Many boards per account (// BOARDS in the README), checked against a running local dev server
// with DEV_LOGIN_CODES=1: `npm run dev:local -- --port 5231 --strictPort`, then `npm run check:boards`
// (or pass another address). It signs up throwaway sb-…@example.com accounts and edits the local D1
// through `wrangler d1 execute --local` to make the owner Pro, from this checkout's .wrangler/state
// (TASKS_STATE_DIR points it elsewhere), the same way check-members.mjs does.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const BASE = (process.argv[2] ?? "http://localhost:5231").replace(/\/+$/, "");
const root = new URL("..", import.meta.url).pathname;
const STATE = process.env.TASKS_STATE_DIR ?? `${root}/.wrangler/state`;
let fails = 0;
const ok = (label, cond, detail) => { console.log(`${cond ? "ok " : "FAIL"} ${label}${cond ? "" : `  -> ${String(JSON.stringify(detail)).slice(0, 400)}`}`); if (!cond) fails++; };
const d1 = (sql) => {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "todo-agent-auth", "--local", "--persist-to", STATE, "--json", "--command", sql], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 90_000 });
  return JSON.parse(out.slice(out.indexOf("[")))[0].results;
};
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function call(who, method, path, body, headers = {}) {
  const r = await fetch(`${BASE}/tasks${path}`, {
    method,
    headers: { ...(who?.cookie ? { Cookie: who.cookie } : {}), ...(body !== undefined && !(body instanceof Uint8Array) ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, data, text, headers: r.headers };
}
async function account(name) {
  const email = `sb-${name}-${randomBytes(3).toString("hex")}@example.com`;
  const start = await call(null, "POST", "/api/auth/start", { email, turnstile: "XXXX.DUMMY.TOKEN.XXXX" });
  const verify = await call(null, "POST", "/api/auth/verify", { email, code: start.data.devCode });
  const cookie = (verify.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie.startsWith("sid=")) throw new Error(`sign-in failed for ${email}: ${verify.status} ${verify.text.slice(0, 200)}`);
  const me = await call({ cookie }, "GET", "/api/me");
  return { name, email, cookie, id: me.data.id };
}
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

const owner = await account("owner");
const member = await account("member");
console.log(`owner ${owner.email} (${owner.id}), member ${member.email}`);

let boards = await call(owner, "GET", "/api/boards");
ok("GET /api/boards lists mine and shared", boards.status === 200 && Array.isArray(boards.data.mine) && boards.data.mine.length === 0 && boards.data.shared.length === 0, boards.data);

const free = await call(owner, "POST", "/api/boards/create", { name: "Shop API" });
ok("a free account can't make a second board (402 pro_required)", free.status === 402 && free.data.code === "pro_required", free.data);

d1(`UPDATE users SET pro_grant = 1 WHERE email = ${q(owner.email)}`);
const bad = await call(owner, "POST", "/api/boards/create", { name: "   " });
ok("a blank name is refused", bad.status === 400 && bad.data.code === "bad_name", bad.data);
const made = await call(owner, "POST", "/api/boards/create", { name: "Shop API" });
ok("Pro makes a board (201, 32-hex id)", made.status === 201 && /^[0-9a-f]{32}$/.test(made.data.board?.id ?? "") && made.data.board.name === "Shop API", made.data);
const B = made.data.board.id;

const acc = await call(owner, "GET", `/api/board/access?board=${B}`);
ok("the owner's access to it is owner", acc.status === 200 && acc.data.access.role === "owner" && acc.data.access.effective === "owner", acc.data);
const mem = await call(owner, "GET", `/api/board/members?board=${B}`);
ok("Members on it is empty and named", mem.status === 200 && mem.data.board.name === "Shop API" && mem.data.board.id === B && mem.data.members.length === 0, mem.data);
const first = await call(owner, "GET", "/api/board/members");
ok("Members with no board is the first board", first.status === 200 && first.data.board.id === owner.id && first.data.board.name === "My board", first.data);
const notMine = await call(member, "GET", `/api/board/members?board=${B}`);
ok("someone else asking for its members gets 404", notMine.status === 404, notMine.data);
const renameByOther = await call(member, "POST", "/api/boards/rename", { board: B, name: "Pwned" });
ok("someone else can't rename it", renameByOther.status === 404, renameByOther.data);
const renameFirst = await call(owner, "POST", "/api/boards/rename", { board: owner.id, name: "Nope" });
ok("the first board can't be renamed", renameFirst.status === 400 && renameFirst.data.code === "first_board", renameFirst.data);

const inv = await call(owner, "POST", "/api/board/invites", { board: B, email: member.email, role: "writer" });
ok("invite into the new board (201 with a dev link)", inv.status === 201 && typeof inv.data.devLink === "string", inv.data);
const token = /#t=([A-Za-z0-9_-]+)/.exec(inv.data.devLink ?? "")?.[1];
const look = await call(member, "POST", "/api/invites/lookup", { token });
ok("the invite names the board", look.status === 200 && look.data.invite?.board === B && look.data.invite.name === "Shop API", look.data);
const accept = await call(member, "POST", "/api/invites/accept", { token });
ok("accepting works and names the board", accept.status === 200 && accept.data.board?.id === B && accept.data.board.name === "Shop API", accept.data);
const theirs = await call(member, "GET", "/api/boards");
ok("the member's list shows it under shared, with its name", theirs.data.shared?.[0]?.board === B && theirs.data.shared[0].name === "Shop API" && theirs.data.shared[0].ownerEmail === owner.email, theirs.data);
const macc = await call(member, "GET", `/api/board/access?board=${B}`);
ok("the member's access to it is writer", macc.status === 200 && macc.data.access.role === "writer" && macc.data.access.effective === "writer", macc.data);
const memNow = await call(owner, "GET", `/api/board/members?board=${B}`);
ok("Members on it lists the writer, and the first board stays unshared", memNow.data.members.length === 1 && (await call(owner, "GET", "/api/board/members")).data.members.length === 0, memNow.data);

const tok = await call(owner, "POST", "/api/tokens", { name: "smoke" });
ok("a personal access token", tok.status === 201 || tok.status === 200, tok.data);
const T = tok.data.token;
const list = await mcp(T, "list_boards");
ok("MCP list_boards names both boards", !list.isError && list.text.includes("My board") && list.text.includes(`Shop API (board ${B})`), list);
const added = await mcp(T, "add_cards", { board: "shop api", lane: "To do", cards: [{ title: "Boards smoke card", tags: ["agent"] }] });
const id = /ids, in the order given: (c[a-z0-9]{4})/.exec(added.text)?.[1];
ok("MCP add_cards by board name (case doesn't matter)", !added.isError && !!id, added);
const all = await mcp(T, "get_board");
ok("MCP get_board with no board shows every board under headings", !all.isError && all.text.includes(`# Shop API (board ${B})`) && all.text.includes(`# My board (board ${owner.id})`) && all.text.includes("Boards smoke card"), all);
const one = await mcp(T, "get_board", { board: B });
ok("MCP get_board by id shows that board alone, no heading", !one.isError && !one.text.includes("# Shop API") && one.text.includes("Boards smoke card"), one);
const mine = await mcp(T, "get_board", { board: "My board" });
ok("MCP get_board 'My board' is the first board, without the smoke card", !mine.isError && !mine.text.includes("Boards smoke card"), mine);
const nope = await mcp(T, "get_board", { board: "nope" });
ok("MCP a board that isn't yours is refused in words", nope.isError && nope.text.includes("no board of yours"), nope);
const card = await mcp(T, "get_card", { id });
ok("MCP get_card finds the card with no board named", !card.isError && card.text.includes("Boards smoke card"), card);
const upd = await mcp(T, "update_card", { id, title: "Boards smoke card 2" });
ok("MCP update_card finds it too", !upd.isError && upd.text.includes("Board now"), upd);
const claimed = await mcp(T, "claim_card", { id, session_id: "tasks-smoke001", agent: "smoke" });
ok("MCP claim_card on the other board", !claimed.isError && claimed.text.includes("Claimed"), claimed);
const seen = await mcp(T, "get_board", { board: "Shop API" });
ok("the claim shows on that board", seen.text.includes("Boards smoke card 2") && seen.text.includes("claimed by"), seen);
const rel = await mcp(T, "release_card", { id, session_id: "tasks-smoke001" });
ok("MCP release_card", !rel.isError && rel.text.includes("Released"), rel);
const found = await mcp(T, "search_cards", { board: "Shop API", query: "smoke" });
ok("MCP search_cards on the named board", !found.isError && found.text.includes("Boards smoke card"), found);

// A file on the new board lands under the board's own prefix.
const body = new TextEncoder().encode("hello from the smoke test");
const up = await call(owner, "POST", `/api/attachments?card=${id}&board=${B}`, body, { "X-Filename": "smoke.txt", "Content-Type": "text/plain", "Content-Length": String(body.length) });
ok("upload to the new board", up.status < 300, { status: up.status, text: up.text.slice(0, 200) });
const attId = up.data?.attachment?.id ?? up.data?.id;
const down = attId ? await call(owner, "GET", `/api/attachments/${attId}?board=${B}`) : null;
ok("download it from the new board", down?.status === 200 && down.text === "hello from the smoke test", down && { status: down.status, text: down.text.slice(0, 80) });
const wrongBoard = attId ? await call(owner, "GET", `/api/attachments/${attId}`) : null;
ok("the first board doesn't have it", wrongBoard?.status === 404, wrongBoard?.status);
const withFile = await mcp(T, "get_card", { id });
ok("MCP get_card shows the file's text from the right prefix", withFile.text.includes("hello from the smoke test"), withFile);

// The member's own agent reaches the board over MCP, as the member (// BOARDS, // TEAM_BOARDS).
const mtok = await call(member, "POST", "/api/tokens", { name: "smoke member" });
const M = mtok.data.token;
const mlist = await mcp(M, "list_boards");
ok("MCP list_boards shows a board shared with you, with the role", !mlist.isError && mlist.text.includes(`Shop API (board ${B}): ${owner.email}'s, you're a writer`), mlist);
const mall = await mcp(M, "get_board");
ok("MCP get_board with no board includes the shared board after your own", !mall.isError && mall.text.includes(`# My board (board ${member.id})`) && mall.text.includes(`# Shop API (board ${B}, ${owner.email}'s, shared with you as a writer)`) && mall.text.includes("Boards smoke card 2"), mall);
const mone = await mcp(M, "get_board", { board: owner.email });
ok("MCP get_board by the owner's email, with the member note", !mone.isError && mone.text.includes("Boards smoke card 2") && mone.text.includes("shared with you as a writer"), mone);
const madd = await mcp(M, "add_cards", { board: "Shop API", cards: [{ title: "From the member's agent" }] });
const mid = /ids, in the order given: (c[a-z0-9]{4})/.exec(madd.text)?.[1];
ok("a writer's agent adds a card to the shared board", !madd.isError && !!mid, madd);
const marked = await mcp(T, "get_card", { id: mid });
ok("and the owner's agent sees it as the member's words", !marked.isError && marked.text.includes(member.email), marked);
const mtag = await mcp(M, "add_cards", { board: "Shop API", cards: [{ title: "Sneaky", tags: ["agent"] }] });
ok("a member's agent can't use the owner's tags", mtag.isError && /agent/.test(mtag.text), mtag);
const mclaim = await mcp(M, "claim_card", { id, session_id: "tasks-member01", agent: "smoke" });
ok("a member's agent can't claim on a shared board", mclaim.isError && mclaim.text.includes("the owner's"), mclaim);
const mask = await mcp(M, "ask_ceo", { id, question: "May I?", options: ["Yes", "No"] });
ok("or ask a question there", mask.isError && mask.text.includes("the owner's"), mask);
const mlane = await mcp(M, "add_lane", { board: "Shop API", name: "Theirs" });
ok("or add a lane", mlane.isError, mlane);
const mcard = await mcp(M, "get_card", { id });
ok("a member's agent reads a card by id with no board named", !mcard.isError && mcard.text.includes("Boards smoke card 2"), mcard);
const demote = await call(owner, "POST", "/api/board/members/role", { board: B, email: member.email, role: "viewer" });
ok("the owner makes the member a viewer", demote.status === 200, demote.data);
const vadd = await mcp(M, "add_cards", { board: "Shop API", cards: [{ title: "Still trying" }] });
ok("a viewer's agent changes nothing", vadd.isError && /view/i.test(vadd.text), vadd);
const vread = await mcp(M, "get_board", { board: B });
ok("but still reads", !vread.isError && vread.text.includes("Boards smoke card 2"), vread);
const nope2 = await mcp(M, "get_board", { board: "My board" });
ok("'My board' is the member's own first board, not the owner's", !nope2.isError && !nope2.text.includes("Boards smoke card 2"), nope2);

const ren = await call(owner, "POST", "/api/boards/rename", { board: B, name: "Shop API v2" });
ok("rename", ren.status === 200 && ren.data.board.name === "Shop API v2", ren.data);
const arch = await call(owner, "POST", "/api/boards/archive", { board: B });
ok("archive", arch.status === 200 && typeof arch.data.board.archivedAt === "number", arch.data);
boards = await call(owner, "GET", "/api/boards");
ok("the list marks it archived", boards.data.mine[0]?.archived === true && boards.data.mine[0].name === "Shop API v2", boards.data);
const allNow = await mcp(T, "get_board");
ok("MCP get_board with no board leaves an archived board out", !allNow.text.includes("Shop API v2") && !allNow.text.includes("# My board"), allNow);
const byName = await mcp(T, "get_board", { board: "Shop API v2" });
ok("but it's still there by name", !byName.isError && byName.text.includes("Boards smoke card 2"), byName);
const un = await call(owner, "POST", "/api/boards/unarchive", { board: B });
ok("unarchive", un.status === 200 && un.data.board.archivedAt === null, un.data);
const archFirst = await call(owner, "POST", "/api/boards/archive", { board: owner.id });
ok("the first board can't be archived", archFirst.status === 400, archFirst.data);

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
