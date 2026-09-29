// Turning encryption on and off, done in the browser: every field and every attachment is
// encrypted (or decrypted) here, attachments are re-uploaded, and the whole board goes to
// the agent in one call, which swaps it in and erases the old copies (agent.ts).

import { openBytes, sealBytes, type BoardKey } from "../sealed";
import type { Attachment, Board, Card } from "../shared";
import { api } from "./base";
import type { Vault } from "./vault";

const MB = 1024 * 1024;
/** A JWE is base64url, a third bigger than the file, and the Worker's cap applies to what it stores. */
export const SEALED_FILE_MAX = Math.floor((25 * MB * 3) / 4) - 4096;

const text = new TextEncoder();

async function failed(r: Response, what: string): Promise<never> {
  const data = (await r.json().catch(() => ({}))) as { error?: string };
  throw new Error(data.error ?? `Couldn't ${what}.`);
}

/** Upload an encrypted file. `card` adds it to that card; without one it's staged for a board swap. */
export async function uploadSealed(vault: Vault, file: { name: string; type: string; bytes: Uint8Array }, card?: string): Promise<Attachment> {
  if (file.bytes.length > SEALED_FILE_MAX) throw new Error(`Encrypted files can be up to ${Math.floor(SEALED_FILE_MAX / MB)} MB.`);
  const body = await sealBytes(vault.key, file.bytes);
  const r = await fetch(api(`/api/attachments?${card ? `card=${encodeURIComponent(card)}` : "stage=1"}`), {
    method: "POST",
    headers: {
      "Content-Type": "application/jose",
      "X-Sealed-Name": await vault.seal(file.name),
      "X-Sealed-Type": await vault.seal(file.type || "application/octet-stream"),
    },
    body: text.encode(body),
  });
  if (!r.ok) await failed(r, `upload ${file.name}`);
  return ((await r.json()) as { attachment: Attachment }).attachment;
}

async function uploadPlainStaged(file: { name: string; type: string; bytes: Uint8Array }): Promise<Attachment> {
  const r = await fetch(api("/api/attachments?stage=1"), {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream", "X-Filename": encodeURIComponent(file.name) },
    body: file.bytes as BufferSource,
  });
  if (!r.ok) await failed(r, `upload ${file.name}`);
  return ((await r.json()) as { attachment: Attachment }).attachment;
}

async function fetchBytes(id: string): Promise<Uint8Array> {
  const r = await fetch(api(`/api/attachments/${id}?download=1`));
  if (!r.ok) await failed(r, "download a file");
  return new Uint8Array(await r.arrayBuffer());
}

/** An encrypted attachment's bytes, decrypted. */
export async function openSealedFile(key: BoardKey, id: string): Promise<Uint8Array> {
  const jwe = new TextDecoder().decode(await fetchBytes(id));
  return openBytes(key, jwe.trim());
}

export type Progress = (done: number, total: number) => void;

/** The plain board, encrypted field by field, with every attachment re-uploaded encrypted. */
export async function sealWholeBoard(plain: Board, vault: Vault, progress: Progress): Promise<Board> {
  const files = plain.cards.flatMap((c) => c.attachments ?? []);
  let done = 0;
  progress(done, files.length);
  const seal = (s: string) => vault.seal(s);
  const lanes = await Promise.all(plain.lanes.map(async (l) => ({ ...l, name: await seal(l.name) })));
  const cards: Card[] = [];
  for (const c of plain.cards) {
    const attachments: Attachment[] = [];
    for (const a of c.attachments ?? []) {
      const bytes = await fetchBytes(a.id);
      const up = await uploadSealed(vault, { name: a.name, type: a.type, bytes });
      attachments.push({ ...up, addedAt: a.addedAt });
      progress(++done, files.length);
    }
    cards.push({
      ...c,
      title: await seal(c.title),
      notes: c.notes ? await seal(c.notes) : "",
      due: c.due === null ? null : await seal(c.due),
      ...(c.attachments ? { attachments } : {}),
    });
  }
  return { ...plain, lanes, cards };
}

/** The decrypted view of an encrypted board, with every attachment re-uploaded as plain bytes. */
export async function plainWholeBoard(view: Board, key: BoardKey, progress: Progress): Promise<Board> {
  const files = view.cards.flatMap((c) => c.attachments ?? []);
  let done = 0;
  progress(done, files.length);
  const cards: Card[] = [];
  for (const c of view.cards) {
    const attachments: Attachment[] = [];
    for (const a of c.attachments ?? []) {
      const bytes = await openSealedFile(key, a.id);
      const up = await uploadPlainStaged({ name: a.name, type: a.type, bytes });
      attachments.push({ ...up, addedAt: a.addedAt });
      progress(++done, files.length);
    }
    cards.push({ ...c, ...(c.attachments ? { attachments } : {}) });
  }
  const { sealed: _, ...rest } = view;
  return { ...rest, cards };
}
