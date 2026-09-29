#!/usr/bin/env node
// Decrypt a Tasks encrypted backup with its passphrase, using nothing but the JOSE standards.
//
//   node scripts/decrypt-board.mjs < tasks-encrypted-2026-09-29.json > board.json
//
// Reads the backup (Encryption → Download encrypted backup) on stdin and writes the plain
// board as JSON on stdout. The passphrase comes from TASKS_PASSPHRASE, or from a prompt on
// the terminal. The format, so any JOSE library can do the same:
//
//   board.sealed.envelope   JWE, alg PBES2-HS512+A256KW, enc A256GCM. The passphrase (NFC,
//                           UTF-8) is the key. The plaintext is the board key as a JWK.
//   every other text field  JWE, alg dir, enc A256GCM, kid = board.sealed.kid, under that key.

import { compactDecrypt, importJWK } from "jose";
import { createInterface } from "node:readline";
import { openSync, createReadStream, createWriteStream } from "node:fs";

const SEALED = /^eyJ[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+$/;

async function readStdin() {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

async function askPassphrase() {
  if (process.env.TASKS_PASSPHRASE) return process.env.TASKS_PASSPHRASE;
  // stdin holds the backup, so ask on the terminal itself.
  let tty;
  try { tty = openSync("/dev/tty", "r+"); } catch { throw new Error("Set TASKS_PASSPHRASE; there's no terminal to ask on."); }
  const input = createReadStream(null, { fd: tty, autoClose: false });
  const output = createWriteStream(null, { fd: tty, autoClose: false });
  const rl = createInterface({ input, output, terminal: true });
  output.write("Passphrase: ");
  rl._writeToOutput = () => {}; // don't echo it
  const answer = await new Promise((resolve) => rl.question("", resolve));
  output.write("\n");
  rl.close();
  return answer;
}

const backup = JSON.parse(await readStdin());
const board = backup.board ?? backup;
if (!board.sealed?.envelope) throw new Error("That isn't an encrypted board.");

const passphrase = await askPassphrase();
let jwk;
try {
  const { plaintext } = await compactDecrypt(board.sealed.envelope, new TextEncoder().encode(passphrase.normalize("NFC")), {
    keyManagementAlgorithms: ["PBES2-HS512+A256KW"], contentEncryptionAlgorithms: ["A256GCM"], maxPBES2Count: 5_000_000,
  });
  jwk = JSON.parse(new TextDecoder().decode(plaintext));
} catch {
  console.error("That passphrase doesn't unlock this board.");
  process.exit(1);
}
const key = await importJWK(jwk, "A256GCM");

const open = async (v) => {
  if (typeof v !== "string" || !SEALED.test(v)) return v;
  const { plaintext } = await compactDecrypt(v, key, { keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"] });
  return new TextDecoder().decode(plaintext);
};

const { sealed: _, ...rest } = board;
const plain = {
  ...rest,
  lanes: await Promise.all(board.lanes.map(async (l) => ({ ...l, name: await open(l.name) }))),
  cards: await Promise.all(board.cards.map(async (c) => ({
    ...c,
    title: await open(c.title),
    notes: await open(c.notes),
    due: await open(c.due),
    ...(c.attachments ? { attachments: await Promise.all(c.attachments.map(async (a) => ({ ...a, name: await open(a.name), type: await open(a.type) }))) } : {}),
  }))),
};
process.stdout.write(JSON.stringify(plain, null, 2) + "\n");
