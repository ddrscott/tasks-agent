// The unlocked board key for an end-to-end encrypted board, and everything that uses it
// in the browser: turning the synced (encrypted) board into the plain one the UI shows,
// encrypting text before it's sent, and revealing ciphertext quoted in chat lines.
//
// The key lives in memory. "Remember on this device" also puts it in IndexedDB as a
// non-extractable CryptoKey: this browser can use it, but no script can read its bytes.

import { isSealed, openText, SEALED_TOKEN_RE, sealedFileSize, sealText, type BoardKey } from "../sealed";
import type { Attachment, Board, Card } from "../shared";

/** Shown in place of a field that won't decrypt (damaged, or encrypted with another key). */
export const UNREADABLE = "[can't decrypt]";

export class Vault {
  private plain = new Map<string, string>();
  constructor(readonly key: BoardKey) {}

  async seal(text: string): Promise<string> {
    const jwe = await sealText(this.key, text);
    this.plain.set(jwe, text);
    return jwe;
  }

  async open(jwe: string): Promise<string> {
    const hit = this.plain.get(jwe);
    if (hit !== undefined) return hit;
    let text: string;
    try {
      text = await openText(this.key, jwe);
    } catch {
      text = UNREADABLE;
    }
    this.plain.set(jwe, text);
    return text;
  }

  /** Decrypt a value if it's sealed. Empty notes and missing dates were never encrypted. */
  private field = (v: string) => (isSealed(v) ? this.open(v) : Promise.resolve(v));

  /** The board with every field decrypted. Keeps `sealed`, so the UI knows it's encrypted. */
  async openBoard(b: Board): Promise<Board> {
    const lanes = await Promise.all(b.lanes.map(async (l) => ({ ...l, name: await this.field(l.name) })));
    const cards = await Promise.all(b.cards.map(async (c): Promise<Card> => ({
      ...c,
      title: await this.field(c.title),
      notes: await this.field(c.notes),
      due: c.due === null ? null : await this.field(c.due),
      ...(c.attachments ? {
        attachments: await Promise.all(c.attachments.map(async (a): Promise<Attachment> => ({
          ...a, name: await this.field(a.name), type: await this.field(a.type),
          size: isSealed(a.name) ? sealedFileSize(a.size, this.key.kid) : a.size,
        }))),
      } : {}),
    })));
    return { ...b, lanes, cards };
  }

  /** Replace every sealed token in a line (tool summaries quote sealed titles) with its text, from what's decrypted so far. */
  revealKnown(s: string): string {
    return s.replace(SEALED_TOKEN_RE, (t: string) => this.plain.get(t) ?? "…");
  }

  /** Decrypt every sealed token in a line. */
  async reveal(s: string): Promise<string> {
    const tokens = s.match(SEALED_TOKEN_RE) ?? [];
    await Promise.all(tokens.map((t) => this.open(t)));
    return this.revealKnown(s);
  }
}

// ---------- remembering the key on this device ----------

const DB = "tasks-vault";
const STORE = "keys";

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  // One connection per call, closed right after, so nothing holds the database open.
  return new Promise<T>((resolve, reject) => {
    const r = fn(d.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }).finally(() => d.close());
}

/** Keep the (non-extractable) key in this browser for this account. */
export async function rememberKey(userId: string, k: BoardKey): Promise<void> {
  try { await tx("readwrite", (s) => s.put({ kid: k.kid, key: k.key }, userId)); } catch { /* private window: memory only */ }
}

export async function recallKey(userId: string, kid: string): Promise<BoardKey | null> {
  try {
    const v = (await tx("readonly", (s) => s.get(userId))) as { kid: string; key: CryptoKey } | undefined;
    return v && v.kid === kid ? { kid: v.kid, key: v.key } : null;
  } catch {
    return null;
  }
}

export async function forgetKey(userId: string): Promise<void> {
  try { await tx("readwrite", (s) => s.delete(userId)); } catch { /* nothing stored */ }
}
