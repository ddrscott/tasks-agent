#!/usr/bin/env node
// The Needle arm of the routing bench: the 80 cases through the real wasm engine, in Node.
//
//   node bench/needle.mjs                 all cases → bench/results/needle.jsonl
//   node bench/needle.mjs --only q01,q09
//   NEEDLE_RS=../needle-rs                where the engine (web/pkg) and weights (models/needle3.cact) live
//
// Then `node bench/run.mjs --score` prints it next to the other arms. The exact build runs here
// (Node has no relaxed SIMD), which is the slower of the two browser builds; the answers are the same.

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RS = resolve(process.env.NEEDLE_RS ?? join(HERE, "..", "..", "needle-rs"));
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
// --resolve: re-run only the client-side resolver over the saved envelopes (no model), for tuning the rules.
const resolveOnly = args.includes("--resolve");

const { CASES, BOARDS, TODAY } = await import("./cases.ts");
const { buildNeedleTools, resolveEnvelope } = await import("../src/needle-tools.ts");

if (resolveOnly) {
  const file = join(HERE, "results", "needle.jsonl");
  const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const [weekday0, today0] = TODAY.split(", ");
  for (const r of rows) {
    if (r.error) continue;
    const c = CASES.find((x) => x.id === r.id); const board = BOARDS[c.board];
    const env = { function_calls: r.calls, suppressed_calls: r.suppressed, confidence: r.conf.complete, validation: r.validation };
    const at = [0.5, 0.6, 0.7, 0.8, 0.9].map((T) => resolveEnvelope(env, board, c.msg, today0, T));
    r.pred = toPred(at[0].ok ? at[0] : resolveEnvelope(env, board, c.msg, today0, 0));
    r.resolved = at.map((x) => x.ok); r.reasons = at.map((x) => (x.ok ? "" : x.reason));
  }
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  process.stderr.write(`re-resolved ${rows.length} rows\n`);
  process.exit(0);
}

const pkg = join(RS, "web", "pkg");
const m = await import(pathToFileURL(join(pkg, "needle_wasm.js")).href);
await m.default({ module_or_path: readFileSync(join(pkg, "needle_wasm_bg.wasm")) });
const t0 = performance.now();
const needle = new m.Needle(readFileSync(join(RS, "models", "needle3.cact")));
process.stderr.write(`engine ${m.simdMode()} · model loaded in ${Math.round(performance.now() - t0)} ms\n`);

// "Wednesday, 2026-09-23" → the pieces the tool builder wants.
const [weekday, today] = TODAY.split(", ");
const cases = CASES.filter((c) => !only || only.includes(c.id));
const rows = [];
process.stderr.write(`needle: ${cases.length} cases `);
for (const c of cases) {
  const board = BOARDS[c.board];
  const set = buildNeedleTools(board, today, weekday);
  needle.init(`${c.board}:${set.key}`, set.system, JSON.stringify(set.tools));
  needle.reset();
  const a = performance.now();
  let env, err = null;
  try { env = JSON.parse(needle.complete(c.msg, 120)); } catch (e) { err = String(e.message ?? e); }
  const msComplete = performance.now() - a;
  if (err) { rows.push({ id: c.id, error: err }); process.stderr.write("x"); continue; }
  // What the client would do at each threshold: the resolved calls, scored like the gold label.
  const at = [0.5, 0.6, 0.7, 0.8, 0.9].map((T) => resolveEnvelope(env, board, c.msg, today, T));
  rows.push({
    id: c.id,
    pred: toPred(at[0].ok ? at[0] : resolveEnvelope(env, board, c.msg, today, 0), board),
    conf: { complete: Number(env.confidence) || 0 },
    resolved: at.map((r) => r.ok),
    reasons: at.map((r) => (r.ok ? "" : r.reason)),
    msComplete: Math.round(msComplete),
    calls: env.function_calls ?? [], suppressed: env.suppressed_calls ?? [], validation: env.validation ?? null, reasoning: env.reasoning ?? "",
  });
  process.stderr.write(".");
}
process.stderr.write("\n");
mkdirSync(join(HERE, "results"), { recursive: true });
const file = join(HERE, "results", "needle.jsonl");
const kept = only && existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !only.includes(r.id)) : [];
writeFileSync(file, [...kept, ...rows].map((r) => JSON.stringify(r)).join("\n") + "\n");
process.stderr.write(`wrote ${file}\n`);

/** The resolved board tool calls in the bench's gold shape: op, card ids, lane id. */
function toPred(r) {
  if (!r.ok) return { op: "none", cards: [] };
  const ops = new Set();
  const cards = [];
  let lane;
  for (const c of r.calls) {
    if (c.name === "move_cards") { ops.add("move"); cards.push(...c.input.ids); lane = c.input.lane; }
    else if (c.name === "add_cards") ops.add("create");
    else if (c.name === "update_card") { ops.add("edit"); cards.push(c.input.id); }
    else if (c.name === "delete_cards") { ops.add("delete"); cards.push(...c.input.ids); }
  }
  return { op: ops.size === 1 ? [...ops][0] : "mixed", cards, lane };
}
