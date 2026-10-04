#!/usr/bin/env node
// Counts the launch copy in docs/launch/ against the limits written next to it, so nobody counts
// characters by eye. A block to check is a fenced block with a comment on the line above:
//
//   <!-- count: chars 1-60 | tagline 1 -->
//   <!-- count: words 150-250 | first comment -->
//
// It also checks the gallery: every `NN-name.png` that product-hunt.md names has to be in
// gallery/ at 2540x1520 or 1270x760 and under 3 MB, the thumbnail has to be 240x240, and
// gallery/ can't hold a picture the copy doesn't name.
//
// Prints every count and exits 1 if one is out of range. `npm run check:launch`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

// ── The gallery ─────────────────────────────────────────────────────────────────────────────
const gallery = resolve(dir, "gallery");
const copy = readFileSync(resolve(dir, "product-hunt.md"), "utf8");
const named = [...new Set([...copy.matchAll(/`((?:\d\d-[a-z0-9-]+|thumbnail-240)\.png)`/g)].map((m) => m[1]))].sort();
const sizes = (name) => name.startsWith("thumbnail") ? ["240x240"] : ["2540x1520", "1270x760"];
if (!named.some((n) => /^\d\d-/.test(n))) { console.log("FAIL product-hunt.md names no gallery images"); failed = true; }
for (const name of named) {
  const file = resolve(gallery, name);
  if (!existsSync(file)) { console.log(`FAIL gallery/${name} is named in product-hunt.md and isn't there`); failed = true; continue; }
  const png = readFileSync(file);
  // A PNG's size is two big-endian ints at bytes 16 and 20.
  const size = `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
  const ok = sizes(name).includes(size) && png.length < 3 * 1024 * 1024;
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} gallery/${name}  ${size}  ${Math.round(png.length / 1024)} KB${ok ? "" : `  (wanted ${sizes(name).join(" or ")}, under 3 MB)`}`);
}
for (const f of readdirSync(gallery).filter((f) => f.endsWith(".png") && !named.includes(f))) {
  console.log(`FAIL gallery/${f} isn't named in product-hunt.md; caption it or delete it`);
  failed = true;
}
process.exit(failed ? 1 : 0);
