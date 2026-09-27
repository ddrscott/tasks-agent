#!/usr/bin/env node
// Drive the routing bench and print a report to stdout.
//
//   node bench/run.mjs                 both arms, all cases
//   node bench/run.mjs --arm glm       one arm
//   node bench/run.mjs --score         re-score saved results without calling any model
//   node bench/run.mjs --only q01,q09  a few cases
//   --k 8 (Jev shortlist size) · --concurrency 3 · --url http://localhost:8799 (skip starting wrangler)
//
// Raw results land in bench/results/<arm>.jsonl, one line per case.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, "results");
const PRICE = { glmIn: 0.06, glmOut: 0.4, jevIn: 0.042 }; // $ per million tokens
const THRESHOLDS = [0.6, 0.7, 0.8, 0.9, 0.95];

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
};
const arms = flag("arm", "all") === "all" ? ["glm", "jev"] : [flag("arm")];
const scoreOnly = flag("score", false) === true;
const only = flag("only", "") ? String(flag("only")).split(",") : null;
const k = Number(flag("k", 8));
const concurrency = Number(flag("concurrency", 3));
let url = flag("url", "");
// Needed only against the deployed bench; see bench/.bench-key.
const KEY_FILE = join(HERE, ".bench-key");
const key = process.env.BENCH_KEY ?? (existsSync(KEY_FILE) ? readFileSync(KEY_FILE, "utf8").trim() : "");
const headers = key ? { "x-bench-key": key } : {};

// ---------- run ----------

let wrangler;
if (!scoreOnly) {
  if (!url) {
    url = "http://localhost:8799";
    wrangler = spawn("npx", ["wrangler", "dev", "-c", join(HERE, "wrangler.jsonc"), "--port", "8799"], { stdio: ["ignore", "ignore", "inherit"] });
    process.on("exit", () => wrangler.kill());
    await waitFor(`${url}/cases`);
  }
  const cases = (await (await fetch(`${url}/cases`, { headers })).json()).filter((c) => !only || only.includes(c.id));
  mkdirSync(RESULTS, { recursive: true });
  for (const arm of arms) {
    process.stderr.write(`${arm}: ${cases.length} cases `);
    const rows = await pool(cases, concurrency, async (c) => {
      const res = await fetch(`${url}/${arm}`, { method: "POST", headers, body: JSON.stringify({ id: c.id, k }) });
      process.stderr.write(res.ok ? "." : "x");
      return { id: c.id, ...(await res.json()) };
    });
    process.stderr.write("\n");
    const file = join(RESULTS, `${arm}.jsonl`);
    const kept = only && existsSync(file) ? load(file).filter((r) => !only.includes(r.id)) : [];
    writeFileSync(file, [...kept, ...rows].map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  wrangler?.kill();
}

// ---------- score ----------

const { CASES } = await import("./cases.ts").catch(() => ({ CASES: null }));
const cases = CASES ?? JSON.parse(readFileSync(join(RESULTS, "cases.json"), "utf8"));
writeFileSync(join(RESULTS, "cases.json"), JSON.stringify(cases));
const byId = Object.fromEntries(cases.map((c) => [c.id, c]));
const out = [];
const say = (s = "") => out.push(s);

// ---------- needle: the small model in the tab (bench/needle.mjs), two policies ----------
{
  const file = join(RESULTS, "needle.jsonl");
  if (existsSync(file)) {
    const rows = load(file).filter((r) => byId[r.id] && (!only || only.includes(r.id)));
    const ok = rows.filter((r) => !r.error);
    const errs = rows.filter((r) => r.error);
    const Ts = [0.5, 0.6, 0.7, 0.8, 0.9];
    say("// NEEDLE");
    say(`cases ${rows.length}, errors ${errs.length}${errs.length ? ` (first: ${errs[0].error})` : ""}`);
    say(`latency (Node, exact build, one thread)  p50 ${p(ok.map((r) => r.msComplete), 50)} ms · p95 ${p(ok.map((r) => r.msComplete), 95)} ms  (the browser's relaxed build is several times faster)`);
    say(`tokens/command  $0 per 1,000 commands`);
    for (const [label, pred, flags] of [["complete(), resolved on the client", (r) => r.pred, (r) => r.resolved]]) {
      say();
      say(`policy: ${label}`);
      say(`  raw answer correct ${pct(ok.filter((r) => correct(pred(r), byId[r.id].gold)).length, ok.length)}`);
      say(byOp(ok, (r) => correct(pred(r), byId[r.id].gold)));
      say("  fast path: act locally when the engine's confidence clears T, the card match is clear, and the call maps to the board");
      say("  T     taken   correct when taken   wrong when taken   acts covered");
      const acts = ok.filter((r) => ["move", "create", "edit", "delete"].includes(byId[r.id].gold.op));
      Ts.forEach((T, i) => {
        const taken = ok.filter((r) => flags(r)[i]);
        const right = taken.filter((r) => correct(pred(r), byId[r.id].gold));
        const wrong = taken.filter((r) => !correct(pred(r), byId[r.id].gold));
        const covered = acts.filter((r) => flags(r)[i] && correct(pred(r), byId[r.id].gold));
        say(`  ${T.toFixed(2)}  ${String(taken.length).padStart(5)}   ${pct(right.length, taken.length).padStart(18)}   ${String(wrong.length).padStart(4)}${wrong.length ? ` (${wrong.map((r) => r.id).join(",")})` : ""}   ${pct(covered.length, acts.length)}`);
      });
    }
    const misses = ok.filter((r) => !correct(r.pred, byId[r.id].gold));
    if (misses.length) {
      say();
      say("misses (what the raw call would have done)");
      for (const r of misses) {
        const c = byId[r.id];
        say(`  ${r.id} "${c.msg}"`);
        say(`       want ${fmt(c.gold)}  got ${fmt(r.pred)}  conf ${r.conf.complete.toFixed(2)}${r.calls.length ? `  call ${r.calls.map((x) => `${x.name}(${JSON.stringify(x.arguments)})`).join(" ")}` : ""}`);
      }
    }
    say();
  }
}

for (const arm of ["glm", "jev"]) {
  const file = join(RESULTS, `${arm}.jsonl`);
  if (!existsSync(file)) continue;
  const rows = load(file).filter((r) => byId[r.id] && (!only || only.includes(r.id)));
  const ok = rows.filter((r) => !r.error);
  const errs = rows.filter((r) => r.error);
  say(`// ${arm.toUpperCase()}`);
  say(`cases ${rows.length}, errors ${errs.length}${errs.length ? ` (first: ${errs[0].error})` : ""}`);
  if (!ok.length) { say(); continue; }

  say(`correct ${pct(ok.filter((r) => correct(r.pred, byId[r.id].gold)).length, ok.length)}`);
  say(byOp(ok, (r) => correct(r.pred, byId[r.id].gold)));

  if (arm === "glm") {
    const changed = ok.filter((r) => r.msFirstChange != null).map((r) => r.msFirstChange);
    say(`latency to first board change  p50 ${p(changed, 50)} ms · p95 ${p(changed, 95)} ms`);
    say(`latency to finished reply      p50 ${p(ok.map((r) => r.msTotal), 50)} ms · p95 ${p(ok.map((r) => r.msTotal), 95)} ms`);
    const inTok = avg(ok.map((r) => r.usage.input)), outTok = avg(ok.map((r) => r.usage.output));
    say(`tokens/command  in ${inTok.toFixed(0)} · out ${outTok.toFixed(0)} · $${((inTok * PRICE.glmIn + outTok * PRICE.glmOut) / 1000).toFixed(4)} per 1,000 commands`);
  } else {
    const ms = ok.map((r) => r.msEmbed + r.msJev);
    say(`latency (query embed + Jev)    p50 ${p(ms, 50)} ms · p95 ${p(ms, 95)} ms  (Jev alone p50 ${p(ok.map((r) => r.msJev), 50)} ms)`);
    const inTok = avg(ok.map((r) => r.usage.input));
    say(`tokens/command  in ${inTok.toFixed(0)} · $${(inTok * PRICE.jevIn / 1000).toFixed(4)} per 1,000 commands (embedding not counted)`);
    const withCards = ok.filter((r) => byId[r.id].gold.cards?.length);
    const recalled = withCards.filter((r) => byId[r.id].gold.cards.every((id) => r.shortlist.includes(id)));
    say(`shortlist (k=${k}) held every right card: ${pct(recalled.length, withCards.length)}`);
    say();
    say("fast path: act without GLM when op=move and every answer clears T");
    say("  T     taken   moves covered   wrong when taken");
    const moves = ok.filter((r) => byId[r.id].gold.op === "move");
    for (const T of THRESHOLDS) {
      const taken = ok.filter((r) => accept(r, T));
      const wrong = taken.filter((r) => !correct(r.pred, byId[r.id].gold));
      const covered = moves.filter((r) => accept(r, T) && correct(r.pred, byId[r.id].gold));
      say(`  ${T.toFixed(2)}  ${String(taken.length).padStart(5)}   ${pct(covered.length, moves.length).padStart(13)}   ${String(wrong.length).padStart(4)}${wrong.length ? `  (${wrong.map((r) => r.id).join(", ")})` : ""}`);
    }
  }

  const misses = ok.filter((r) => !correct(r.pred, byId[r.id].gold));
  if (misses.length) {
    say();
    say("misses");
    for (const r of misses) {
      const c = byId[r.id];
      say(`  ${r.id} "${c.msg}"`);
      say(`       want ${fmt(c.gold)}  got ${fmt(r.pred)}${r.conf ? `  (op ${r.conf.op?.toFixed(2)}, lane ${r.conf.lane?.toFixed(2)})` : ""}`);
    }
  }
  say();
}
process.stdout.write(out.join("\n") + "\n");
process.exit(0);

// ---------- helpers ----------

function correct(pred, gold) {
  if (!pred) return false;
  if (gold.op === "ask") return pred.op === "ask" || pred.op === "none";
  if (pred.op !== gold.op) return false;
  if (["none", "create", "mixed"].includes(gold.op)) return true;
  if (!sameSet(pred.cards, gold.cards)) return false;
  return gold.op !== "move" || pred.lane === gold.lane || (gold.laneAlt ?? []).includes(pred.lane);
}

/** The fast path takes a Jev answer only when it's a plain move and nothing is in the gray zone. */
function accept(r, T) {
  if (r.pred.op !== "move" || !r.pred.lane || !r.pred.cards.length) return false;
  if (r.conf.op < T || r.conf.lane < T || (r.conf.scope ?? 1) < T) return false;
  return Object.values(r.conf.rel).every((p) => p >= T || p <= 1 - T);
}

function byOp(rows, ok) {
  const groups = {};
  for (const r of rows) (groups[byId[r.id].gold.op] ??= []).push(r);
  return "  " + Object.entries(groups).map(([op, rs]) => `${op} ${rs.filter(ok).length}/${rs.length}`).join(" · ");
}

function sameSet(a = [], b = []) {
  const x = [...a].sort(), y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}
function fmt(g) {
  return `${g.op}${g.cards?.length ? ` [${g.cards.join(",")}]` : ""}${g.lane ? ` → ${g.lane}` : ""}`;
}
function pct(n, d) {
  return `${n}/${d} (${d ? Math.round((100 * n) / d) : 0}%)`;
}
function avg(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function p(xs, q) {
  if (!xs.length) return "–";
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((q / 100) * s.length))];
}
function load(file) {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}
async function waitFor(u) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(u)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`wrangler dev never answered at ${u}`);
}
