// End-to-end encryption, built only from open standards so a board can be read anywhere
// the passphrase is known, including outside this app:
//
// - The board key is a random 256-bit AES key, written as a JWK (RFC 7517).
// - The passphrase wraps it in a JWE (RFC 7516) with PBES2-HS512+A256KW (RFC 7518 §4.8):
//   PBKDF2-HMAC-SHA512 over the passphrase, then AES key wrap. That JWE is the "envelope".
//   The server stores it, and it's useless without the passphrase.
// - Every piece of text (lane names, card titles, notes, due dates, attachment names and
//   types, chat messages) and every attachment's bytes is its own compact JWE:
//   alg "dir", enc "A256GCM", kid naming the board key. Each gets a fresh random IV.
//
// Encryption and decryption only ever happen in the browser (and in scripts/decrypt-board.mjs).
// The server only uses isSealed() and assertSealedBoard() to refuse plaintext on an encrypted board.

import { CompactEncrypt, compactDecrypt } from "jose";

/** PBKDF2 rounds for the envelope. OWASP's floor for PBKDF2-HMAC-SHA512 is 210,000. */
export const PBES2_COUNT = 600_000;
export const ENVELOPE_ALG = "PBES2-HS512+A256KW";
export const MIN_PASSPHRASE = 12;

/** A compact JWE with alg "dir": protected header, an empty key segment, IV, ciphertext, tag. */
const SEALED_RE = /^eyJ[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+$/;
/** The same, found inside a longer string (tool summaries quote sealed titles). */
export const SEALED_TOKEN_RE = /eyJ[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+/g;

/** Longest sealed value the server accepts: 4,000 characters of notes at four bytes each, as base64url, plus the header. */
export const MAX_SEALED = 24_000;

export const isSealed = (s: unknown): boolean => typeof s === "string" && s.length <= MAX_SEALED && SEALED_RE.test(s);

/** What an encrypted board carries so any device can unlock it. */
export type SealInfo = {
  v: 1;
  /** The board key's id, repeated in every field's JWE header. */
  kid: string;
  /** The board key as a JWK, encrypted to the passphrase (PBES2-HS512+A256KW, A256GCM). */
  envelope: string;
  since: string;
};

export type BoardKey = { kid: string; key: CryptoKey };

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Same passphrase, same bytes, on every device and keyboard. */
const passBytes = (passphrase: string) => enc.encode(passphrase.normalize("NFC"));

const b64url = (bytes: Uint8Array) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A new random board key, and its envelope under `passphrase`. */
export async function createBoardKey(passphrase: string): Promise<{ boardKey: BoardKey; envelope: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const kid = b64url(crypto.getRandomValues(new Uint8Array(9)));
  const envelope = await wrapRaw(raw, kid, passphrase);
  return { boardKey: { kid, key: await importRaw(raw) }, envelope };
}

async function wrapRaw(raw: Uint8Array, kid: string, passphrase: string): Promise<string> {
  const jwk = { kty: "oct", k: b64url(raw), alg: "A256GCM", kid, key_ops: ["encrypt", "decrypt"], ext: true };
  return new CompactEncrypt(enc.encode(JSON.stringify(jwk)))
    .setProtectedHeader({ alg: ENVELOPE_ALG, enc: "A256GCM", cty: "jwk+json", kid })
    .setKeyManagementParameters({ p2c: PBES2_COUNT })
    .encrypt(passBytes(passphrase));
}

/** The raw board key inside an envelope. Throws on a wrong passphrase (the AES key wrap fails its integrity check). */
async function unwrapRaw(envelope: string, passphrase: string): Promise<{ raw: Uint8Array; kid: string }> {
  const { plaintext } = await compactDecrypt(envelope, passBytes(passphrase), {
    keyManagementAlgorithms: [ENVELOPE_ALG],
    contentEncryptionAlgorithms: ["A256GCM"],
    maxPBES2Count: 5_000_000,
  });
  const jwk = JSON.parse(dec.decode(plaintext)) as { kty: string; k: string; kid: string };
  if (jwk.kty !== "oct" || typeof jwk.k !== "string") throw new Error("That envelope doesn't hold a board key.");
  const raw = Uint8Array.from(atob(jwk.k.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("That envelope doesn't hold a 256-bit key.");
  return { raw, kid: jwk.kid };
}

/** Unlock a board key with the passphrase. The key comes back non-extractable. */
export async function unlockBoardKey(seal: SealInfo, passphrase: string): Promise<BoardKey> {
  let got: { raw: Uint8Array; kid: string };
  try {
    got = await unwrapRaw(seal.envelope, passphrase);
  } catch {
    throw new Error("That passphrase doesn't unlock this board.");
  }
  if (got.kid !== seal.kid) throw new Error("The board key doesn't match this board.");
  return { kid: got.kid, key: await importRaw(got.raw) };
}

/** A new envelope for the same board key under a different passphrase. Needs the current one. */
export async function rewrapBoardKey(seal: SealInfo, current: string, next: string): Promise<string> {
  let got: { raw: Uint8Array; kid: string };
  try {
    got = await unwrapRaw(seal.envelope, current);
  } catch {
    throw new Error("The current passphrase is wrong.");
  }
  return wrapRaw(got.raw, got.kid, next);
}

const importRaw = (raw: Uint8Array) =>
  crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

export async function sealBytes(k: BoardKey, bytes: Uint8Array): Promise<string> {
  return new CompactEncrypt(bytes).setProtectedHeader({ alg: "dir", enc: "A256GCM", kid: k.kid }).encrypt(k.key);
}

export async function openBytes(k: BoardKey, jwe: string): Promise<Uint8Array> {
  const { plaintext } = await compactDecrypt(jwe, k.key, { keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"] });
  return plaintext;
}

export const sealText = (k: BoardKey, text: string) => sealBytes(k, enc.encode(text));
export const openText = async (k: BoardKey, jwe: string) => dec.decode(await openBytes(k, jwe));

/**
 * Proof that a caller holds the board key, without revealing it: AES-GCM over 32 zero bytes
 * with an all-zero IV. Deterministic, so the server can keep a hash and compare later, and
 * it only ever encrypts that one message under that IV. (Data fields use random 96-bit IVs;
 * one landing on all zeros is a 2^-96 chance.) Turning encryption off and changing the
 * passphrase need it, so a stolen session alone can't do either.
 */
export async function keyProof(k: BoardKey): Promise<string> {
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, k.key, new Uint8Array(32));
  return b64url(new Uint8Array(ct));
}

/** What the server stores and compares: SHA-256 of the proof, hex. */
export async function proofHash(proof: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(`tasks-key-proof:${proof}`));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A sealed file's plaintext size, from its stored size. A "dir" compact JWE is
 * header.(empty).iv.ciphertext.tag in base64url, and here the header, 12-byte IV, and 16-byte
 * tag are fixed lengths, so what's left is the ciphertext, which AES-GCM keeps the same size.
 */
export function sealedFileSize(stored: number, kid: string): number {
  const header = Math.ceil((JSON.stringify({ alg: "dir", enc: "A256GCM", kid }).length * 4) / 3);
  const fixed = header + 16 + 22 + 4;
  return Math.max(0, Math.floor(((stored - fixed) * 3) / 4));
}

/** The kid in a sealed value's header, without decrypting it. */
export function kidOf(jwe: string): string | undefined {
  try {
    const h = JSON.parse(atob(jwe.slice(0, jwe.indexOf(".")).replace(/-/g, "+").replace(/_/g, "/"))) as { kid?: string };
    return h.kid;
  } catch {
    return undefined;
  }
}
