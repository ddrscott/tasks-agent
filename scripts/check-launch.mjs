#!/usr/bin/env node
// Counts the launch copy in docs/launch/ against the limits written next to it, so nobody counts
// characters by eye. A block to check is a fenced block with a comment on the line above:
//
//   <!-- count: chars 1-60 | tagline 1 -->
//   <!-- count: words 150-250 | first comment -->
//
// Prints every count and exits 1 if one is out of range. `npm run check:launch`.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../docs/launch");
const block = /<!-- count: (chars|words) (\d+)-(\d+) \| ([^>]+?) -->\n```[a-z]*\n([\s\S]*?)\n```/g;

let failed = false, seen = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
  const text = readFileSync(resolve(dir, file), "utf8");
  for (const [, unit, min, max, label, body] of text.matchAll(block)) {
    seen++;
    // Characters the way a form counts them: code points, line breaks included.
    const n = unit === "chars" ? [...body].length : body.split(/\s+/).filter(Boolean).length;
    const ok = n >= Number(min) && n <= Number(max);
    if (!ok) failed = true;
    console.log(`${ok ? "ok  " : "FAIL"} ${String(n).padStart(4)} ${unit} (${min}-${max})  ${file}: ${label}`);
  }
}
if (!seen) { console.error(`FAIL no counted blocks found in ${dir}`); process.exit(1); }
process.exit(failed ? 1 : 0);
