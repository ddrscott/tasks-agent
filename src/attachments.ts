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
// Removing an attachment only drops it from the board, so undo can bring it back.
// TodoAgent.collectAttachments deletes R2 objects once nothing refers to them.

import { getAgentByName } from "agents";
import { currentUser, type User } from "./auth";
import { kidOf } from "./sealed";
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

async function usedBytes(env: Env, user: User): Promise<number> {
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
  const sealedName = req.headers.get("X-Sealed-Name");
  const sealedType = req.headers.get("X-Sealed-Type");
  const sealed = sealedName !== null || sealedType !== null;
  if (sealed && !(isSealed(sealedName) && isSealed(sealedType))) return json({ error: "The file's name and type have to be encrypted too." }, 400);

  // What this board accepts. An encrypted board takes files encrypted under its key, and plain
  // ones only while the owner is turning encryption off (beginDisable). A plain board takes
  // encrypted files only as staged uploads, which is how turning encryption on works.
  const agent = await getAgentByName(env.TodoAgent, user.id);
  const policy = await agent.uploadPolicy();
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
  if ((await usedBytes(env, user)) + size > quota) {
    return json({ error: `That would go over your ${quota / MB} MB of attachment space. Remove some files first.` }, 413);
  }

  const att: Attachment = {
    id: `a${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    name: sealed ? sealedName! : cleanName(req.headers.get("X-Filename")),
    size,
    type: sealed ? sealedType! : cleanType(req.headers.get("Content-Type")),
    addedAt: new Date().toISOString(),
  };
  const key = `${user.id}/${att.id}`;
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

  const r = await agent.attach(cardId!, att);
  if (!r.ok) {
    await env.ATTACHMENTS.delete(key);
    return json({ error: r.error }, 400);
  }
  return json({ attachment: att });
}

async function download(req: Request, env: Env, user: User, id: string): Promise<Response> {
  if (!/^a[0-9a-f]{16}$/.test(id)) return json({ error: "not found" }, 404);
  const obj = await env.ATTACHMENTS.get(`${user.id}/${id}`);
  if (!obj) return json({ error: "That file is gone." }, 404);

  // Ciphertext goes back as is, for the browser to decrypt. Never inline.
  if (obj.customMetadata?.sealed === "1") {
    return new Response(obj.body, {
      headers: {
        "Content-Type": "application/jose", "Content-Length": String(obj.size), "Content-Disposition": `attachment; filename="${id}.jwe"`,
        "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600", ETag: obj.httpEtag,
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
    "Cache-Control": "private, max-age=3600",
    ETag: obj.httpEtag,
  });
  // PDFs need the browser's viewer; everything else renders with no scripts at all.
  if (type !== "application/pdf") headers.set("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  return new Response(obj.body, { headers });
}

/** /api/attachments routes. Session only: agents see attachment names, not files. */
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
