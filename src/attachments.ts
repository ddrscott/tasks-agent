// Card attachments. The bytes live in R2 at `<user id>/<attachment id>`; the board
// holds only name, size, and type (shared.ts). Keys start with the user id, so a
// download can only ever reach the signed-in user's own files.
//
// Upload:   POST /tasks/api/attachments?card=<card id>   body = the file,
//           X-Filename: <url-encoded name>, Content-Type, Content-Length required
//           ?stage=1 instead of ?card= stores the file without adding it to a card; turning
//           encryption on or off re-uploads every file that way, then swaps the board.
// Encrypted boards: the body is a compact JWE the browser made (sealed.ts), and the name and
//           type arrive the same way in X-Sealed-Name and X-Sealed-Type. The Worker stores
//           ciphertext and never learns either.
// Download: GET  /tasks/api/attachments/<attachment id>[?download=1]
//
// A shared board (// TEAM_BOARDS): add ?board=<the owner's id> to either call. The member is
//           checked with `access` (members.ts) first. A viewer can download and nothing else,
//           a writer can upload, the file lands under the owner's prefix and counts against
//           the owner's quota, and a member can only download files that are on the board now.
//
// Removing an attachment only drops it from the board, so undo can bring it back.
// TodoAgent.collectAttachments deletes R2 objects once nothing refers to them.

import { getAgentByName } from "agents";
import { currentUser, type User } from "./auth";
import { kidOf } from "./sealed";
import { access, spendBoardCall, tooFast } from "./members";
import { BOARD_ID, errorCode, plainError, SLOW_DOWN } from "./member-rules";
import { isSealed, type Attachment } from "./shared";

const MB = 1024 * 1024;

// Types a browser may show inline. Everything else downloads, so an uploaded HTML or
// SVG file can never run as a page on this origin.
const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "application/pdf", "text/plain"]);

const json = (body: unknown, status = 200) => Response.json(body, { status });
const limit = (v: string | undefined, fallback: number) => (Number(v) > 0 ? Number(v) : fallback) * MB;

function cleanName(raw: string | null): string {
  let name = "file";
  try { name = decodeURIComponent(raw ?? "") || name; } catch { /* keep default */ }
  name = name.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f"]/g, "").trim();
  return (name || "file").slice(0, 200);
}

function cleanType(raw: string | null): string {
  const t = (raw ?? "").split(";")[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(t) ? t : "application/octet-stream";
}

/**
 * Whose files this request is about. No `board`, or your own id: yours. Anyone else's id goes
 * through the membership check, and every failure is the same "not found".
 */
async function boardOf(req: Request, env: Env, user: User): Promise<{ ownerId: string; member: null | "viewer" | "writer"; lapsed: boolean } | Response | null> {
  const board = new URL(req.url).searchParams.get("board");
  if (board === null || board === user.id) return { ownerId: user.id, member: null, lapsed: false };
  // In order of cost: an id that can't be a board, then this account's allowance for calls
  // about other people's boards (a 429, with no lookup), and only then the membership read.
  if (!BOARD_ID.test(board)) return null;
  const slow = spendBoardCall(user.id);
  if (slow) return slow;
  const a = await access(env, user, board);
  if (a.effective !== "viewer" && a.effective !== "writer") return null;
  return { ownerId: board, member: a.effective, lapsed: a.reason === "plan_lapsed" };
}

const notFound = () => json({ error: "not found" }, 404);

async function usedBytes(env: Env, user: { id: string }): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await env.ATTACHMENTS.list({ prefix: `${user.id}/`, cursor });
    for (const o of page.objects) total += o.size;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return total;
}

async function upload(req: Request, env: Env, user: User): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const cardId = q.get("card");
  const staged = q.get("stage") === "1";
  if (!cardId && !staged) return json({ error: "Which card? Missing ?card=" }, 400);
  const where = await boardOf(req, env, user);
  if (!where) return notFound();
  if (where instanceof Response) return where;
  if (where.member === "viewer") {
    return json({ error: where.lapsed ? "This board is view only until its owner's Pro plan is back." : "You can view this board, not change it.", code: "read_only" }, 403);
  }
  // Staged uploads only exist to turn encryption on or off, which is the owner's.
  if (where.member && staged) return notFound();
  const ownerId = where.ownerId;
  const sealedName = req.headers.get("X-Sealed-Name");
  const sealedType = req.headers.get("X-Sealed-Type");
  const sealed = sealedName !== null || sealedType !== null;
  if (sealed && !(isSealed(sealedName) && isSealed(sealedType))) return json({ error: "The file's name and type have to be encrypted too." }, 400);

  // What this board accepts. An encrypted board takes files encrypted under its key, and plain
  // ones only while the owner is turning encryption off (beginDisable). A plain board takes
  // encrypted files only as staged uploads, which is how turning encryption on works.
  const agent = await getAgentByName(env.TodoAgent, ownerId);
  const policy = await agent.uploadPolicy(where.member ? user.id : undefined, cardId);
  if (policy.slow) return json({ error: plainError(SLOW_DOWN), code: "slow_down" }, 429);
  if (policy.refused) return json({ error: plainError(policy.refused), code: errorCode(policy.refused) ?? "read_only" }, 403);
  if (where.member && policy.kid) return notFound(); // an encrypted board has no members
  if (policy.kid) {
    if (!sealed && !(staged && policy.plainStaging)) return json({ error: "This board is encrypted, so files have to be too. Reload the page." }, 400);
    if (sealed && (kidOf(sealedName!) !== policy.kid || kidOf(sealedType!) !== policy.kid)) return json({ error: "That file was encrypted with a different key. Reload the page." }, 400);
  } else if (sealed && !staged) {
    return json({ error: "This board isn't encrypted. Reload the page." }, 400);
  }
  const size = Number(req.headers.get("Content-Length"));
  const max = limit(env.ATTACHMENT_MAX_MB, 25);
  if (!req.body || !Number.isFinite(size) || size <= 0) return json({ error: "That file is empty." }, 400);
  if (size > max) return json({ error: `Files can be up to ${max / MB} MB.` }, 413);
  const quota = limit(env.ATTACHMENT_QUOTA_MB, 250);
  // A member's upload counts against the board owner's space: the file is theirs to keep.
  if ((await usedBytes(env, { id: ownerId })) + size > quota) {
    return json({ error: where.member
      ? `That would go over this board's ${quota / MB} MB of attachment space.`
      : `That would go over your ${quota / MB} MB of attachment space. Remove some files first.` }, 413);
  }

  const att: Attachment = {
    id: `a${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    name: sealed ? sealedName! : cleanName(req.headers.get("X-Filename")),
    size,
    type: sealed ? sealedType! : cleanType(req.headers.get("Content-Type")),
    addedAt: new Date().toISOString(),
  };
  const key = `${ownerId}/${att.id}`;
  let body: ReadableStream | Uint8Array = req.body;
  if (sealed) {
    // Check it's really ciphertext under the same key before storing it, not a plain file with sealed headers.
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length !== size || !isSealedFile(bytes, kidOf(sealedName!)!)) return json({ error: "That file isn't encrypted the way this board expects." }, 400);
    body = bytes;
  }
  // An encrypted file keeps nothing readable in R2: no name, no type, no card.
  await env.ATTACHMENTS.put(key, body, sealed
    ? { httpMetadata: { contentType: "application/jose" }, customMetadata: { sealed: "1" } }
    : { httpMetadata: { contentType: att.type }, customMetadata: { name: att.name, ...(cardId ? { card: cardId } : {}) } });
  if (staged) {
    await agent.noteStaged(); // collected later if the board swap never happens
    return json({ attachment: att });
  }

  // The board checks the member again, with the same function, before it takes the file.
  const r = await agent.attach(cardId!, att, { id: user.id, email: user.email });
  if (!r.ok) {
    await env.ATTACHMENTS.delete(key);
    return json({ error: plainError(r.error) }, 400);
  }
  return json({ attachment: att });
}

async function download(req: Request, env: Env, user: User, id: string): Promise<Response> {
  if (!/^a[0-9a-f]{16}$/.test(id)) return notFound();
  const where = await boardOf(req, env, user);
  if (!where) return notFound();
  if (where instanceof Response) return where;
  // The owner can still fetch a file undo could bring back. A member gets what's on the board
  // now, and the board counts the download against that member before R2 is read (fileFor).
  if (where.member) {
    const file = await (await getAgentByName(env.TodoAgent, where.ownerId)).fileFor(user.id, id);
    if (file === "gone") return notFound();
    if (file !== "ok") return tooFast(file.retryAfter);
  }
  const obj = await env.ATTACHMENTS.get(`${where.ownerId}/${id}`);
  if (!obj) return where.member ? notFound() : json({ error: "That file is gone." }, 404);
  // A member's copy isn't kept by the browser, so it's gone from there too once they're removed.
  const cache = where.member ? "no-store" : "private, max-age=3600";

  // Ciphertext goes back as is, for the browser to decrypt. Never inline.
  if (obj.customMetadata?.sealed === "1") {
    return new Response(obj.body, {
      headers: {
        "Content-Type": "application/jose", "Content-Length": String(obj.size), "Content-Disposition": `attachment; filename="${id}.jwe"`,
        "X-Content-Type-Options": "nosniff", "Cache-Control": cache, ETag: obj.httpEtag,
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  }
  const type = obj.httpMetadata?.contentType ?? "application/octet-stream";
  const inline = INLINE.has(type) && new URL(req.url).searchParams.get("download") !== "1";
  const name = obj.customMetadata?.name ?? id;
  const headers = new Headers({
    "Content-Type": inline ? type : "application/octet-stream",
    "Content-Length": String(obj.size),
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": cache,
    ETag: obj.httpEtag,
  });
  // PDFs need the browser's viewer; everything else renders with no scripts at all.
  if (type !== "application/pdf") headers.set("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  return new Response(obj.body, { headers });
}

/** /api/attachments routes. Session only: agents read files through the MCP get_card tool instead (mcp.ts). */
export async function handleAttachments(req: Request, env: Env, path: string): Promise<Response | null> {
  if (path !== "/api/attachments" && !path.startsWith("/api/attachments/")) return null;
  const user = await currentUser(req, env);
  if (!user) return json({ error: "signed out" }, 401);
  if (path === "/api/attachments" && req.method === "POST") return upload(req, env, user);
  const id = path.slice("/api/attachments/".length);
  if (id && req.method === "GET") return download(req, env, user, id);
  return null;
}

/**
 * Whether the bytes are one compact JWE with alg "dir", enc A256GCM, and `kid` in the header:
 * base64url segments only, with the empty key segment "dir" has.
 */
function isSealedFile(bytes: Uint8Array, kid: string): boolean {
  let dots = 0;
  for (const b of bytes) {
    if (b === 0x2e) { dots++; continue; }
    const ok = (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2d || b === 0x5f;
    if (!ok) return false;
  }
  if (dots !== 4) return false;
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 400)));
  const [h, empty] = head.split(".");
  if (empty !== "") return false;
  try {
    const header = JSON.parse(atob(h.replace(/-/g, "+").replace(/_/g, "/"))) as { alg?: string; enc?: string; kid?: string };
    return header.alg === "dir" && header.enc === "A256GCM" && header.kid === kid;
  } catch {
    return false;
  }
}
