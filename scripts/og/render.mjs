#!/usr/bin/env node
// Renders the share image and the home-screen icon from the HTML next to this file, with
// headless Chrome. Run it with `npm run og` after editing og.html or icon.html, and commit
// the PNGs. CHROME=/path/to/chrome points it at another Chrome or Chromium.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../public/tasks");
const chrome = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!existsSync(chrome)) {
  console.error(`No Chrome at ${chrome}. Set CHROME to a Chrome or Chromium binary.`);
  process.exit(1);
}

const shots = [
  { html: "og.html", png: "og.png", width: 1200, height: 630 },
  { html: "icon.html", png: "apple-touch-icon.png", width: 180, height: 180 },
];

let failed = false;
for (const { html, png, width, height } of shots) {
  const file = resolve(out, png);
  execFileSync(chrome, [
    "--headless", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    // Wait for the web fonts before the shot; without this the text lands in a fallback face.
    "--virtual-time-budget=10000",
    `--window-size=${width},${height}`, `--screenshot=${file}`,
    pathToFileURL(resolve(here, html)).href,
  ], { stdio: ["ignore", "ignore", "ignore"] });
  // A PNG's size is two big-endian ints at bytes 16 and 20.
  const head = readFileSync(file);
  const w = head.readUInt32BE(16), h = head.readUInt32BE(20);
  const ok = w === width && h === height;
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} public/tasks/${png} ${w}x${h}${ok ? "" : ` (wanted ${width}x${height})`}`);
}
process.exit(failed ? 1 : 0);
