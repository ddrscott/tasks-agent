#!/usr/bin/env node
// Many boards per account (// BOARDS in the README), checked against a running local dev server
// with DEV_LOGIN_CODES=1: `npm run dev:local -- --port 5231 --strictPort`, then `npm run check:boards`
// (or pass another address). It signs up throwaway sb-…@example.com accounts and edits the local D1
// through `wrangler d1 execute --local` to make the owner Pro, from this checkout's .wrangler/state
// (TASKS_STATE_DIR points it elsewhere), the same way check-members.mjs does.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";

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

/** The board socket as the app opens it, for the one thing MCP can't do: answer a question (answerAsk). */
async function sock(who, board) {
  const url = `${BASE.replace(/^http/, "ws")}/tasks/agent?_pk=${randomBytes(6).toString("hex")}${board ? `&board=${board}` : ""}`;
  const ws = new WebSocket(url, { headers: { Cookie: who.cookie }, handshakeTimeout: 15_000 });
  const frames = [];
  let wake = [];
  ws.on("message", (d) => { try { frames.push(JSON.parse(d.toString())); } catch { /* not json */ } const w = wake; wake = []; for (const f of w) f(); });
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  return {
    async rpc(method, args) {
      const id = randomBytes(6).toString("hex");
      const from = frames.length;
      ws.send(JSON.stringify({ type: "rpc", id, method, args }));
      const end = Date.now() + 8000;
      for (;;) {
        const hit = frames.slice(from).find((f) => f.type === "rpc" && f.id === id);
        if (hit) return hit;
        if (Date.now() > end) return { success: false, error: "no reply" };
        await Promise.race([new Promise((r) => wake.push(r)), new Promise((r) => setTimeout(r, 200))]);
      }
    },
    close() { try { ws.close(); } catch { /* gone */ } },
  };
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
// Pages and files on a board (// PAGES): the REST API, then the page tools over MCP.
const md = (t) => new TextEncoder().encode(t);
const p1 = await call(owner, "PUT", `/api/files/docs/plan.md?board=${B}`, md("# Plan\n\nHello there"), { "Content-Type": "text/markdown", "Content-Length": "19" });
ok("PUT makes a page (201, page: true, an ETag)", p1.status === 201 && p1.data.file?.page === true && p1.data.file.path === "docs/plan.md" && !!p1.headers.get("ETag"), p1.data);
const E1 = p1.headers.get("ETag");
const plist = await call(owner, "GET", `/api/files?board=${B}`);
ok("GET lists it", plist.status === 200 && plist.data.files?.some((f) => f.path === "docs/plan.md"), plist.data);
const pget = await call(owner, "GET", `/api/files/docs/plan.md?board=${B}`, undefined, { Accept: "application/json" });
ok("GET reads it as JSON with the text", pget.status === 200 && pget.data.text === "# Plan\n\nHello there" && pget.data.file.etag === E1, pget.data);
const praw = await call(owner, "GET", `/api/files/docs/plan.md?board=${B}`);
ok("and as text/markdown", praw.status === 200 && praw.headers.get("Content-Type")?.startsWith("text/markdown") && praw.text.startsWith("# Plan"), praw.text);
const pstale = await call(owner, "PUT", `/api/files/docs/plan.md?board=${B}`, md("# Plan v2"), { "Content-Type": "text/markdown", "Content-Length": "9", "If-Match": "deadbeef" });
ok("PUT with a stale etag is a 412 conflict", pstale.status === 412 && pstale.data.code === "conflict", pstale.data);
const pnew = await call(owner, "PUT", `/api/files/docs/plan.md?board=${B}`, md("# Plan v2"), { "Content-Type": "text/markdown", "Content-Length": "9", "If-None-Match": "*" });
ok("PUT create-only on an existing page is a 412 exists", pnew.status === 412 && pnew.data.code === "exists", pnew.data);
const pok = await call(owner, "PUT", `/api/files/docs/plan.md?board=${B}`, md("# Plan v2"), { "Content-Type": "text/markdown", "Content-Length": "9", "If-Match": E1 });
ok("PUT with the right etag replaces it", pok.status === 200 && pok.data.file.etag !== E1, pok.data);
const prev = await call(owner, "GET", `/api/files/docs/plan.md/revisions?board=${B}`);
ok("the earlier version is kept", prev.status === 200 && prev.data.revisions?.length === 1 && prev.data.revisions[0].etag === E1, prev.data);
const pold = await call(owner, "GET", `/api/files/docs/plan.md/revisions?board=${B}&rev=${E1}`);
ok("and can be read back", pold.status === 200 && pold.data.text === "# Plan\n\nHello there", pold.data);
const pbad = await call(owner, "PUT", `/api/files/..%2Fetc%2Fpasswd?board=${B}`, md("x"), { "Content-Type": "text/plain", "Content-Length": "1" });
ok("a path with .. is refused", pbad.status === 400 && pbad.data.code === "bad_path", pbad.data);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const pbin = await call(owner, "PUT", `/api/files/img/dot.png?board=${B}`, png, { "Content-Type": "image/png", "Content-Length": String(png.length) });
ok("a binary file lands as a file, not a page", pbin.status === 201 && pbin.data.file.page === false && pbin.data.file.type === "image/png", pbin.data);
const pbinGet = await fetch(`${BASE}/tasks/api/files/img/dot.png?board=${B}`, { headers: { Cookie: owner.cookie } });
ok("and comes back byte for byte", pbinGet.status === 200 && new Uint8Array(await pbinGet.arrayBuffer()).join() === png.join() && pbinGet.headers.get("Content-Type") === "image/png");
const pmember = await call(member, "PUT", `/api/files/docs/from-member.md?board=${B}`, md("hi"), { "Content-Type": "text/markdown", "Content-Length": "2" });
ok("a writer makes a page on the shared board", pmember.status === 201 && pmember.data.file.updatedBy === member.email, pmember.data);
const pstranger = await call(member, "GET", `/api/files/docs/plan.md`);
ok("with no board it's the member's own board, which has no such page", pstranger.status === 404, pstranger.data);
const pmove = await call(owner, "POST", "/api/files/move", { board: B, from: "docs/plan.md", to: "docs/plan-final.md" });
ok("move", pmove.status === 200 && pmove.data.file.path === "docs/plan-final.md" && (await call(owner, "GET", `/api/files/docs/plan.md?board=${B}`)).status === 404, pmove.data);
const pdel = await call(owner, "DELETE", `/api/files/img/dot.png?board=${B}`);
ok("delete", pdel.status === 200 && pdel.data.deleted === true && (await call(owner, "GET", `/api/files/img/dot.png?board=${B}`)).status === 404, pdel.data);

const w1 = await mcp(T, "write_page", { board: "Shop API", path: "notes/a.md", text: "# A\n\nalpha beta" });
ok("MCP write_page creates a page", !w1.isError && w1.text.startsWith("Created notes/a.md"), w1);
const l1 = await mcp(T, "list_pages", { board: "Shop API" });
ok("MCP list_pages lists it with who changed it", !l1.isError && l1.text.includes("notes/a.md (page, text/markdown") && l1.text.includes(owner.email), l1);
const r1 = await mcp(T, "read_page", { board: "Shop API", path: "notes/a.md" });
const Ep = /etag ([0-9a-f]+)/.exec(r1.text)?.[1];
ok("MCP read_page gives the text and an etag", !r1.isError && r1.text.includes("alpha beta") && !!Ep, r1);
const e1 = await mcp(T, "edit_page", { board: "Shop API", path: "notes/a.md", find: "beta", replace: "gamma", etag: Ep });
ok("MCP edit_page replaces one passage", !e1.isError && e1.text.startsWith("Edited"), e1);
const e2 = await mcp(T, "edit_page", { board: "Shop API", path: "notes/a.md", find: "gamma", replace: "delta", etag: Ep });
ok("with a stale etag it's refused", e2.isError && e2.text.includes("changed since you read it"), e2);
const e3 = await mcp(T, "edit_page", { board: "Shop API", path: "notes/a.md", find: "zzz", replace: "y" });
ok("text that isn't there is refused in words", e3.isError && e3.text.includes("isn't in the page"), e3);
const e4 = await mcp(T, "edit_page", { board: "Shop API", path: "notes/a.md", find: "a", replace: "b" });
ok("text that's there more than once is refused with the count", e4.isError && /appears \d+ times/.test(e4.text), e4);
const r2 = await mcp(T, "read_page", { board: "Shop API", path: "notes/a.md" });
ok("the edit landed", r2.text.includes("alpha gamma"), r2);
const mw = await mcp(M, "write_page", { board: "Shop API", path: "notes/member.md", text: "mine" });
ok("a writer's agent writes a page on the shared board", !mw.isError && mw.text.startsWith("Created"), mw);
const pd1 = await mcp(T, "delete_page", { board: "Shop API", path: "notes/a.md" });
ok("MCP delete_page", !pd1.isError && pd1.text.startsWith("Deleted notes/a.md") && (await mcp(T, "read_page", { board: "Shop API", path: "notes/a.md" })).isError, pd1);

// A card assigned to the member is theirs to work: claim, STATUS, move, ask, answer (// ASSIGNEE).
const assign = await mcp(T, "update_card", { id, tags: ["agent"], assignee: member.email });
ok("the owner tags a card for agents and assigns it to the member", !assign.isError, assign);
const aboard = await mcp(M, "get_board", { board: B });
ok("the member's agent sees the assignment on the card line", aboard.text.includes(`(assigned to ${member.email})`), aboard);
const aclaim = await mcp(M, "claim_card", { id, session_id: "tasks-member01", agent: "smoke" });
ok("the member's agent claims it", !aclaim.isError && aclaim.text.includes("Claimed"), aclaim);
const astatus = await mcp(M, "update_card", { id, notes: "STATUS: on it" });
ok("writes its STATUS line", !astatus.isError, astatus);
const atitle = await mcp(M, "update_card", { id, title: "Renamed by the member" });
ok("but can't retitle it", atitle.isError && atitle.text.includes("assigned to you"), atitle);
const amove = await mcp(M, "move_cards", { ids: [id], lane: "Doing" });
ok("moves it to Doing", !amove.isError, amove);
const aask = await mcp(M, "ask_ceo", { id, question: "Ship it?", options: ["Yes", "No"], recommended: 1, session_id: "tasks-member01" });
ok("asks a question on it", !aask.isError && aask.text.includes("Asked on"), aask);
const await1 = await mcp(M, "wait_for_answer", { ids: [id], seconds: 1, session_id: "tasks-member01" });
ok("and waits", !await1.isError && await1.text.includes("Nothing is answered yet"), await1);
const os = await sock(owner, B);
const oans = await os.rpc("answerAsk", [id, { choice: 0 }]);
ok("the owner answers from the app", oans.success === true, oans);
const awaited = await mcp(M, "wait_for_answer", { ids: [id], seconds: 2, session_id: "tasks-member01" });
ok("and the member's agent hears it", !awaited.isError && awaited.text.includes("ANSWERED"), awaited);
const aask2 = await mcp(M, "ask_ceo", { id, question: "And now?", options: ["Go", "Stop"], session_id: "tasks-member01" });
const ms = await sock(member, B);
const mans = await ms.rpc("answerAsk", [id, { choice: 1 }]);
ok("the member answers their own card's question from the app", !aask2.isError && mans.success === true, { aask2, mans });
const other = await mcp(T, "add_cards", { board: "Shop API", cards: [{ title: "Owner's own work order", tags: ["agent"] }] });
const oid = /ids, in the order given: (c[a-z0-9]{4})/.exec(other.text)?.[1];
const mans2 = await ms.rpc("updateCard", [oid, { notes: "mine now" }]);
ok("but not another agent card", mans2.success === false && /agents/.test(mans2.error ?? ""), mans2);
const unassign = await mcp(T, "update_card", { id, assignee: null });
ok("the owner takes the assignment back", !unassign.isError, unassign);
const aclaim2 = await mcp(M, "claim_card", { id, session_id: "tasks-member01", agent: "smoke" });
ok("and the member's agent can't claim it anymore", aclaim2.isError && aclaim2.text.includes("the owner's"), aclaim2);
os.close(); ms.close();

// Search across boards (// SEARCH): the app's endpoint and the MCP tool, over cards and pages
// on every board the caller can reach. Index rows are written after each change, so wait a beat.
await new Promise((r) => setTimeout(r, 800));
const s1 = await call(owner, "GET", "/api/search?q=smoke");
const sHit = s1.data?.hits?.find((h) => h.id === id);
ok("GET /api/search finds a card on the second board, with its board and lane", s1.status === 200 && sHit?.kind === "card" && sHit.board === B && sHit.boardName === "Shop API" && sHit.lane === "Doing" && sHit.title.includes("smoke"), s1.data);
ok("without a vector index it says meaning-based search is unavailable", s1.data?.semantic === "unavailable", s1.data?.semantic);
const s2 = await call(owner, "GET", "/api/search?q=plan");
const pHit = s2.data?.hits?.find((h) => h.kind === "page");
ok("a page is found by its words, under its moved path, with its heading as the title", pHit?.id === "docs/plan-final.md" && pHit.board === B && pHit.title.includes("Plan"), s2.data);
ok("and the old path is gone from the index", !s2.data?.hits?.some((h) => h.id === "docs/plan.md"), s2.data);
const s3 = await call(owner, "GET", "/api/search?q=plan&kind=card");
ok("kind=card leaves pages out", s3.status === 200 && !s3.data.hits.some((h) => h.kind === "page"), s3.data);
const s4 = await call(owner, "GET", "/api/search?q=alpha");
ok("a deleted page is out of the index", s4.status === 200 && !s4.data.hits.some((h) => h.id === "notes/a.md"), s4.data);
const s5 = await call(owner, "GET", `/api/search?q=smoke&board=${B}`);
ok("board= narrows to one board", s5.status === 200 && s5.data.hits.some((h) => h.id === id), s5.data);
const s6 = await call(owner, "GET", "/api/search?q=smoke&board=nope");
ok("a board that isn't yours is a 404", s6.status === 404, s6.data);
const s7 = await call(owner, "GET", "/api/search");
ok("no query is a 400", s7.status === 400, s7.data);
const s8 = await call(member, "GET", "/api/search?q=smoke");
ok("a member searching finds the shared board's card", s8.status === 200 && s8.data.hits.some((h) => h.id === id && h.board === B), s8.data);
const stranger = await account("stranger");
const s9 = await call(stranger, "GET", "/api/search?q=smoke");
ok("someone who isn't on the board finds nothing", s9.status === 200 && s9.data.hits.length === 0, s9.data);
const ms1 = await mcp(T, "search", { query: "smoke" });
ok("MCP search names the board and lane on a card hit", !ms1.isError && ms1.text.includes(`[${id}]`) && ms1.text.includes("Shop API · Doing"), ms1);
const ms2 = await mcp(T, "search", { query: "plan", kind: "page" });
ok("MCP search lists a page hit by its path", !ms2.isError && ms2.text.includes("page docs/plan-final.md"), ms2);
const ms3 = await mcp(T, "search", { query: "member's agent" });
ok("a card a member wrote says so on its hit", !ms3.isError && ms3.text.includes(`[${mid}]`) && ms3.text.includes(member.email), ms3);
const ms4 = await mcp(T, "search", { query: "smoke", board: "Shop API" });
ok("MCP search on one board leaves the board name off", !ms4.isError && ms4.text.includes(`[${id}]`) && !ms4.text.includes("Shop API ·"), ms4);
const ms5 = await mcp(M, "search", { query: "smoke" });
ok("a member's agent searches the shared board too", !ms5.isError && ms5.text.includes(`[${id}]`), ms5);
const ms6 = await mcp(T, "search", { query: "zzzqqq" });
ok("nothing matching says so", !ms6.isError && ms6.text.startsWith("Nothing matches"), ms6);

// Worksheets (// WORKSHEETS): typed tables over REST, then over MCP, then read-only SQL.
const sh = await call(owner, "POST", "/api/sheets", { board: B, name: "Sales 2026", columns: [{ name: "Region" }, { name: "Amount", type: "number" }, { name: "When", type: "date" }, { name: "Paid", type: "checkbox" }] });
ok("POST /api/sheets makes a worksheet with typed columns (201)", sh.status === 201 && /^s[a-z0-9]{5}$/.test(sh.data.sheet?.id ?? "") && sh.data.sheet.columns.length === 4 && sh.data.sheet.columns[1].type === "number", sh.data);
const SH = sh.data.sheet.id;
ok("a second worksheet with the same name is a 409", (await call(owner, "POST", "/api/sheets", { board: B, name: "sales 2026", columns: [{ name: "X" }] })).status === 409);
ok("a worksheet can't be named like one of the store's own tables", (await call(owner, "POST", "/api/sheets", { board: B, name: "pages", columns: [{ name: "X" }] })).status === 400);
const ins = await call(owner, "POST", `/api/sheets/${SH}/rows`, { board: B, rows: [{ Region: "East", Amount: "1,200", When: "2026-10-01", Paid: "yes" }, { region: "West", amount: 800, when: "2026-10-02", paid: false }] });
ok("POST rows adds two, coercing a formatted number, a yes, and column names in any case", ins.status === 201 && ins.data.ids?.length === 2, ins.data);
const [R1, R2] = ins.data.ids ?? [];
const badNum = await call(owner, "POST", `/api/sheets/${SH}/rows`, { board: B, rows: [{ Amount: "lots" }] });
ok("a word in a number column is refused, naming the column", badNum.status === 400 && badNum.data.code === "bad_value" && badNum.data.error.includes("Amount"), badNum.data);
const badCol = await call(owner, "POST", `/api/sheets/${SH}/rows`, { board: B, rows: [{ Nope: 1 }] });
ok("an unknown column is refused, listing the real ones", badCol.status === 400 && badCol.data.code === "bad_column" && badCol.data.error.includes("Region"), badCol.data);
const got = await call(owner, "GET", `/api/sheets/${SH}?board=${B}`);
ok("GET reads the rows with typed cells and who wrote them", got.status === 200 && got.data.rows.length === 2 && got.data.rows[0].Amount === 1200 && got.data.rows[0].Paid === 1 && got.data.rows[1].Paid === 0 && got.data.rows[0]._by === owner.email, got.data);
const sorted = await call(owner, "GET", `/api/sheets/Sales%202026?board=${B}&sort=Amount&dir=asc`);
ok("by name, sorted by a column", sorted.status === 200 && sorted.data.rows[0].Region === "West", sorted.data);
const shUpd = await call(owner, "PATCH", `/api/sheets/${SH}/rows`, { board: B, updates: [{ id: R1, cells: { Amount: 900 } }] });
ok("PATCH changes a cell", shUpd.status === 200 && shUpd.data.changed === 1, shUpd.data);
ok("PATCH on a row that doesn't exist is a 404, and nothing changes", (await call(owner, "PATCH", `/api/sheets/${SH}/rows`, { board: B, updates: [{ id: 99999, cells: { Amount: 1 } }] })).status === 404);
const qr = await call(owner, "POST", "/api/sheets/query", { board: B, sql: 'SELECT Region, SUM(Amount) AS total FROM "Sales 2026" GROUP BY Region ORDER BY Region' });
ok("POST query runs a SELECT with the worksheet as a table", qr.status === 200 && qr.data.columns?.join() === "Region,total" && JSON.stringify(qr.data.rows) === JSON.stringify([["East", 900], ["West", 800]]), qr.data);
for (const sql of ['DELETE FROM "Sales 2026"', 'WITH x AS (SELECT 1) DELETE FROM "Sales 2026"', 'SELECT 1; DROP TABLE "Sales 2026"', 'PRAGMA table_info("Sales 2026")', 'INSERT INTO "Sales 2026" (Region) VALUES (1)']) {
  ok(`a query that isn't a plain SELECT is refused: ${sql.slice(0, 30)}`, (await call(owner, "POST", "/api/sheets/query", { board: B, sql })).status === 400);
}
ok("and the rows are all still there", (await call(owner, "GET", `/api/sheets/${SH}?board=${B}`)).data.total === 2);
const colAdd = await call(owner, "POST", `/api/sheets/${SH}/columns`, { board: B, name: "Notes" });
ok("POST columns adds one", colAdd.status === 201 && colAdd.data.sheet.columns.length === 5 && colAdd.data.sheet.columns[4].name === "Notes", colAdd.data);
const notesId = colAdd.data.sheet.columns[4].id;
const colRen = await call(owner, "PATCH", `/api/sheets/${SH}/columns/${notesId}`, { board: B, name: "Comment", pos: 0 });
ok("PATCH renames and moves a column", colRen.status === 200 && colRen.data.sheet.columns[0].name === "Comment", colRen.data);
ok("a query sees the new column name at once", (await call(owner, "POST", "/api/sheets/query", { board: B, sql: 'SELECT Comment FROM "Sales 2026" LIMIT 1' })).status === 200);
const colDel = await call(owner, "DELETE", `/api/sheets/${SH}/columns/${notesId}?board=${B}`);
ok("DELETE drops it", colDel.status === 200 && colDel.data.sheet.columns.length === 4, colDel.data);
const shRen = await call(owner, "POST", `/api/sheets/${SH}/rename`, { board: B, name: "Sales FY26" });
ok("rename a worksheet", shRen.status === 200 && shRen.data.sheet.name === "Sales FY26", shRen.data);
ok("a query uses the new name", (await call(owner, "POST", "/api/sheets/query", { board: B, sql: 'SELECT COUNT(*) AS n FROM "Sales FY26"' })).data.rows?.[0]?.[0] === 2);
const csvOut = await fetch(`${BASE}/tasks/api/sheets/${SH}/export?board=${B}`, { headers: { Cookie: owner.cookie } });
const csvText = await csvOut.text();
ok("export is CSV with the header and the rows", csvOut.status === 200 && csvOut.headers.get("Content-Type")?.startsWith("text/csv") && csvText.startsWith("Region,Amount,When,Paid") && csvText.includes("East,900,2026-10-01,1"), csvText.slice(0, 120));
const imp = await call(owner, "POST", "/api/sheets/import", { board: B, name: "Imported", csv: 'Name,Qty,Day,Link\n"Smith, A",1,2026-01-01,https://example.com\nB,2.5,2026-01-02,https://example.org\n' });
ok("import infers text, number, date, and link columns and loads the rows", imp.status === 201 && imp.data.rows === 2 && imp.data.sheet.columns.map((c) => c.type).join() === "text,number,date,link", imp.data);
ok("a quoted CSV cell with a comma survives", (await call(owner, "GET", `/api/sheets/${imp.data.sheet.id}?board=${B}`)).data.rows[0].Name === "Smith, A");
const mIns = await call(member, "POST", `/api/sheets/${SH}/rows`, { board: B, rows: [{ Region: "North", Amount: 5 }] });
ok("a writer adds a row, stamped as theirs", mIns.status === 201 && (await call(owner, "GET", `/api/sheets/${SH}?board=${B}`)).data.rows.find((r) => r._id === mIns.data.ids[0])?._by === member.email, mIns.data);
ok("a stranger gets 404", (await call(stranger, "GET", `/api/sheets?board=${B}`)).status === 404);
const del = await call(owner, "DELETE", `/api/sheets/${SH}/rows`, { board: B, ids: [R2] });
ok("DELETE rows", del.status === 200 && del.data.deleted === 1 && del.data.sheet.rows === 2, del.data);
const impDel = await call(owner, "DELETE", `/api/sheets/${imp.data.sheet.id}?board=${B}`);
ok("DELETE a worksheet", impDel.status === 200 && impDel.data.deleted === true && (await call(owner, "GET", `/api/sheets/${imp.data.sheet.id}?board=${B}`)).status === 404, impDel.data);

const cs = await mcp(T, "create_sheet", { board: "Shop API", name: "Budget", columns: [{ name: "Line" }, { name: "Cost", type: "number" }], rows: [{ Line: "Hosting", Cost: 20 }, { Line: "Email", Cost: 5 }] });
ok("MCP create_sheet makes a worksheet with rows", !cs.isError && cs.text.startsWith("Created worksheet Budget") && cs.text.includes("2 rows"), cs);
const ls = await mcp(T, "list_sheets", { board: "Shop API" });
ok("MCP list_sheets names it with its columns and count", !ls.isError && ls.text.includes("Budget (id s") && ls.text.includes("2 rows") && ls.text.includes("Cost (number)"), ls);
const rs = await mcp(T, "read_sheet", { board: "Shop API", sheet: "budget" });
ok("MCP read_sheet is a markdown table with _id first", !rs.isError && rs.text.includes("| _id | Line | Cost |") && rs.text.includes("| Hosting | 20 |"), rs);
const wr = await mcp(T, "write_rows", { board: "Shop API", sheet: "Budget", rows: [{ Line: "Domain", Cost: "12" }] });
ok("MCP write_rows adds a row and says its id", !wr.isError && wr.text.includes("Added 1 row") && /Row ids: \d+/.test(wr.text), wr);
const qs = await mcp(T, "query_sheet", { board: "Shop API", sql: "SELECT SUM(Cost) AS total FROM Budget" });
ok("MCP query_sheet aggregates", !qs.isError && qs.text.includes("| 37 |"), qs);
const ur = await mcp(T, "update_rows", { board: "Shop API", sheet: "Budget", updates: [{ id: 1, cells: { Cost: 25 } }] });
ok("MCP update_rows", !ur.isError && ur.text.includes("Updated 1 row") && (await mcp(T, "query_sheet", { board: "Shop API", sql: "SELECT SUM(Cost) FROM Budget" })).text.includes("| 42 |"), ur);
const ac = await mcp(T, "add_column", { board: "Shop API", sheet: "Budget", name: "Note" });
ok("MCP add_column", !ac.isError && ac.text.includes("Added column Note"), ac);
const dr = await mcp(T, "delete_rows", { board: "Shop API", sheet: "Budget", ids: [3] });
ok("MCP delete_rows", !dr.isError && dr.text.includes("Deleted 1 row"), dr);
const qbad = await mcp(T, "query_sheet", { board: "Shop API", sql: "DROP TABLE Budget" });
ok("MCP query_sheet refuses anything but SELECT", qbad.isError && qbad.text.includes("Only SELECT"), qbad);
const mq = await mcp(M, "query_sheet", { board: "Shop API", sql: "SELECT COUNT(*) AS n FROM Budget" });
ok("a member's agent queries the shared board's worksheets", !mq.isError && mq.text.includes("| 2 |"), mq);
const mwRow = await mcp(M, "write_rows", { board: "Shop API", sheet: "Budget", rows: [{ Line: "CDN", Cost: 3 }] });
ok("a writer's agent adds a row", !mwRow.isError && mwRow.text.includes("Added 1 row"), mwRow);

const demote = await call(owner, "POST", "/api/board/members/role", { board: B, email: member.email, role: "viewer" });
ok("the owner makes the member a viewer", demote.status === 200, demote.data);
const vadd = await mcp(M, "add_cards", { board: "Shop API", cards: [{ title: "Still trying" }] });
ok("a viewer's agent changes nothing", vadd.isError && /view/i.test(vadd.text), vadd);
const vrows = await mcp(M, "write_rows", { board: "Shop API", sheet: "Budget", rows: [{ Line: "Nope", Cost: 1 }] });
ok("a viewer's agent can't write worksheet rows", vrows.isError && /view/i.test(vrows.text), vrows);
ok("but still reads and queries them", !(await mcp(M, "query_sheet", { board: "Shop API", sql: "SELECT COUNT(*) FROM Budget" })).isError);
ok("and a viewer's own session can't write rows either (403 read_only)", (await call(member, "POST", `/api/sheets/${SH}/rows`, { board: B, rows: [{ Region: "Nope" }] })).status === 403);
const vread = await mcp(M, "get_board", { board: B });
ok("but still reads", !vread.isError && vread.text.includes("Boards smoke card 2"), vread);
const vw = await mcp(M, "write_page", { board: "Shop API", path: "notes/v.md", text: "no" });
ok("a viewer's agent can't write a page", vw.isError && /view/.test(vw.text), vw);
const vr = await mcp(M, "read_page", { board: "Shop API", path: "notes/member.md" });
ok("but still reads one", !vr.isError && vr.text.includes("mine"), vr);
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
