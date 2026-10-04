#!/usr/bin/env node
// Shoots the Product Hunt gallery from the running app: the demo board, the Connect page, and
// the landing page, into docs/launch/gallery/. Run it with `npm run shots` while a dev server
// (or the live site) is up.
//
//   node scripts/shots.mjs [base-url] [--scheme dark|light] [--only 03,06] [--scale 1|2]
//
// base-url defaults to http://localhost:5190 (TASKS_SHOTS_URL also sets it). It drives the
// Chrome in /Applications over the DevTools protocol with Node's own WebSocket, so there's
// nothing to install; CHROME=/path/to/chrome points it at another Chrome or Chromium.
//
// Every shot waits for the thing it's a picture of and exits 1 with the reason when that
// thing isn't there, so a change to the demo or a page shows up as a failed run, not as a
// wrong picture. Nothing is hard-coded about which card asks the question: it takes the
// first card on the demo board that shows answer buttons.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const outDir = resolve(root, "docs/launch/gallery");

// Product Hunt's own numbers (https://www.producthunt.com/launch/preparing-for-launch, read
// 2026-10-03): gallery 1270x760 recommended, thumbnail 240x240, every image under 3 MB.
const W = 1270, H = 760, THUMB = 240, MAX_BYTES = 3 * 1024 * 1024;
const PHONE = { width: 390, height: 844 };
const WAIT_MS = 15_000;
const HOSTED = "https://askscottpierce.com";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const scheme = flag("scheme", "dark");
const only = flag("only", "");
const scale = Number(flag("scale", "2"));
if (args.includes("--help") || args.includes("-h")) {
  console.log("usage: node scripts/shots.mjs [base-url] [--scheme dark|light] [--only 03,06] [--scale 1|2]");
  process.exit(0);
}
// Either the origin or the app's own address works: http://localhost:5190 or …/tasks/.
const base = (args[0] || process.env.TASKS_SHOTS_URL || "http://localhost:5190").replace(/\/+$/, "").replace(/\/tasks$/, "");
const app = `${base}/tasks`;

class ShotError extends Error {}
const die = (msg) => { throw new ShotError(msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Chrome over the DevTools protocol ───────────────────────────────────────────────────────

const chromePath = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let proc, profile, ws, nextId = 0;
const pending = new Map();

async function launch() {
  if (!existsSync(chromePath)) die(`No Chrome at ${chromePath}. Set CHROME to a Chrome or Chromium binary.`);
  profile = mkdtempSync(join(tmpdir(), "tasks-shots-"));
  proc = spawn(chromePath, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "about:blank",
  ], { stdio: "ignore" });
  const portFile = join(profile, "DevToolsActivePort");
  let port = "";
  for (let i = 0; i < 100 && !port; i++) {
    if (existsSync(portFile)) port = readFileSync(portFile, "utf8").split("\n")[0];
    if (!port) await sleep(100);
  }
  if (!port) die("Chrome started but never opened its DevTools port.");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === "page") ?? die("Chrome has no page to drive.");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new ShotError("Couldn't connect to Chrome's DevTools socket.")); });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const p = m.id && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.no(new ShotError(`${p.method}: ${m.error.message}`)); else p.ok(m.result);
  };
  await send("Page.enable");
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }, { name: "prefers-reduced-motion", value: "reduce" }] });
  // No animation is ever caught halfway, and no text cursor blinks into one run and not the next.
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `addEventListener("DOMContentLoaded", () => {
      const s = document.createElement("style");
      s.textContent = "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important;-webkit-tap-highlight-color:transparent!important;scroll-behavior:auto!important}";
      document.head.append(s);
    });`,
  });
}

function send(method, params = {}) {
  return new Promise((ok, no) => {
    const id = ++nextId;
    pending.set(id, { ok, no, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function quit() {
  try { ws?.close(); } catch {}
  try { proc?.kill(); } catch {}
  if (profile) setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} }, 300).unref?.();
}

/** Run a function in the page and return what it returns. Arguments are passed as JSON. */
async function inPage(fn, ...a) {
  const r = await send("Runtime.evaluate", {
    expression: `(${fn})(${a.map((x) => JSON.stringify(x)).join(",")})`, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) die(`Page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

/** Poll until fn returns something truthy; fail with `what` when it never does. */
async function waitFor(what, fn, ...a) {
  const until = Date.now() + WAIT_MS;
  for (;;) {
    const v = await inPage(fn, ...a);
    if (v) return v;
    if (Date.now() > until) die(`Waited ${WAIT_MS / 1000}s for ${what} and it never showed up (${await inPage(() => location.href)}).`);
    await sleep(100);
  }
}

async function viewport({ width, height, mobile = false, dpr = scale }) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile });
  await send("Emulation.setTouchEmulationEnabled", { enabled: mobile });
}

async function goto(path) {
  const url = `${app}${path}`;
  await send("Page.navigate", { url });
  await waitFor(`${url} to load`, (u) => location.href.startsWith(u.split("#")[0]) && document.readyState === "complete", url);
  await inPage(() => document.fonts.ready.then(() => true));
}

/** A real click (or tap, on the phone) in the middle of the first element matching selector. */
async function click(selector, what, { touch = false } = {}) {
  const at = await waitFor(what, (s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  }, selector);
  if (touch) {
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    return;
  }
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: 1 });
}

async function key(k) {
  const e = { key: k, code: k, windowsVirtualKeyCode: k === "Enter" ? 13 : 0, text: k === "Enter" ? "\r" : undefined };
  await send("Input.dispatchKeyEvent", { type: "keyDown", ...e });
  await send("Input.dispatchKeyEvent", { type: "keyUp", ...e });
}

/** Park the pointer where it hovers nothing, and let two frames paint. */
async function settle() {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
  await inPage(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));
}

async function capture() {
  await settle();
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  return Buffer.from(data, "base64");
}

const written = [];
function save(name, png, width, height) {
  // A PNG's size is two big-endian ints at bytes 16 and 20.
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  if (w !== width || h !== height) die(`${name} came out ${w}x${h}, wanted ${width}x${height}.`);
  if (png.length >= MAX_BYTES) die(`${name} is ${(png.length / 1048576).toFixed(1)} MB; Product Hunt wants images under 3 MB. Try --scale 1.`);
  writeFileSync(join(outDir, name), png);
  written.push(`ok   docs/launch/gallery/${name}  ${w}x${h}  ${Math.round(png.length / 1024)} KB`);
}

// ── What the shots lean on ──────────────────────────────────────────────────────────────────

/** The demo board, loaded fresh (a reload starts its script over), with a question on a card. */
async function demo() {
  await goto("/demo");
  // The id of the first card showing answer buttons, with one of them marked recommended.
  return waitFor("a card on the demo board with an agent's question and answer buttons (.ask-opt)", () => {
    const opt = document.querySelector("[data-card-id] .ask-opt");
    const card = opt?.closest("[data-card-id]");
    if (!card || !card.querySelector(".ask-opt.rec")) return null;
    return card.getAttribute("data-card-id");
  });
}

/**
 * The Connect page prints the address it was loaded from, so a shot from a dev server would read
 * http://localhost:5190/tasks/mcp. The gallery should read what a visitor sees, so the local
 * origin is swapped for the hosted one in the text and field values on screen. Against the
 * live site this changes nothing.
 */
async function showHostedOrigin() {
  if (base === HOSTED) return;
  await inPage((from, to) => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.nodeValue.includes(from)) n.nodeValue = n.nodeValue.replaceAll(from, to);
    // Uncontrolled from here on; nothing types in these during a shot.
    for (const f of document.querySelectorAll("input, textarea")) if (f.value.includes(from)) f.value = f.value.replaceAll(from, to);
    return true;
  }, base, HOSTED);
}

const popoverOpen = (button, body) => waitFor(`the list ${button} opens (${body})`, (b, s) => {
  const btn = document.querySelector(b), el = document.querySelector(s);
  return btn?.getAttribute("aria-expanded") === "true" && !!el && el.getBoundingClientRect().height > 40;
}, button, body);

// ── The shots, in gallery order ─────────────────────────────────────────────────────────────

const shots = {
  async "01-board-question"() {
    await viewport({ width: W, height: H });
    await demo();
    await waitFor("the “need you” count in the top bar", () => /need/.test(document.querySelector(".asks-btn")?.textContent ?? ""));
    return capture();
  },

  async "02-need-you"() {
    await viewport({ width: W, height: H });
    await demo();
    await click(".asks-btn", "the “need you” button");
    await popoverOpen(".asks-btn", ".asks");
    await waitFor("an answer button in the “need you” list", () => !!document.querySelector(".asks .ask-opt"));
    return capture();
  },

  async "03-sessions"() {
    await viewport({ width: W, height: H });
    await demo();
    await click(".sess-btn", "the Sessions button");
    await popoverOpen(".sess-btn", ".sessions");
    await waitFor("at least two projects in the Sessions list", () => document.querySelectorAll(".sessions .sess-project").length >= 2);
    return capture();
  },

  async "04-card"() {
    await viewport({ width: W, height: H });
    const id = await demo();
    // Enter on a focused card opens it. A click in the middle of this one would land on an answer.
    await inPage((i) => document.querySelector(`[data-card-id="${i}"]`).focus(), id);
    await key("Enter");
    await waitFor("the open card's notes rendered as markdown (.dialog-body .md)", () => !!document.querySelector(".dialog-body .md"));
    await waitFor("a STATUS line in the open card's notes", () => /STATUS:/.test(document.querySelector(".dialog-body .md")?.textContent ?? ""));
    await waitFor("the claiming session's row in the open card (Copy resume command)", () => !!document.querySelector(".dialog-body .sess-resume"));
    return capture();
  },

  async "05-connect"() {
    await viewport({ width: W, height: H });
    await goto("/connect");
    await waitFor("the Connect page's numbered steps (.connect-step)", () => document.querySelectorAll(".connect-step .step-num").length >= 3);
    // Step 02 has a tab per client. Claude Code's is the one with a command to copy.
    await inPage(() => {
      const tab = [...document.querySelectorAll(".connect-step [role=tab]")].find((b) => b.textContent.trim() === "Claude Code");
      tab?.setAttribute("data-shot", "tab");
    });
    await click('[data-shot="tab"]', "a “Claude Code” tab in the Connect page's step 02");
    await waitFor("the `claude mcp add` command on the Connect page", () => /claude mcp add/.test(document.querySelector(".connect-step [role=tabpanel]")?.textContent ?? ""));
    await showHostedOrigin();
    // Start the frame at step 01, clear of whatever the top bar covers.
    await inPage(() => {
      const first = document.querySelector(".connect-step");
      const bar = document.querySelector(".topbar, header");
      const covered = bar && getComputedStyle(bar).position !== "static" ? bar.getBoundingClientRect().bottom : 0;
      scrollTo(0, scrollY + first.getBoundingClientRect().top - covered - 28);
    });
    return capture();
  },

  async "06-phone"() {
    // Two real 390-wide screens, set side by side on a gallery-sized canvas.
    await viewport({ ...PHONE, mobile: true, dpr: 2 });
    await demo();
    // One lane fills a phone, so bring the lane with the question into view.
    await inPage(() => document.querySelector("[data-card-id] .ask-opt").closest("[data-card-id]").scrollIntoView({ inline: "center", block: "nearest" }));
    await waitFor("the question card to be on screen at 390 wide", () => {
      const r = document.querySelector("[data-card-id] .ask-opt")?.getBoundingClientRect();
      return !!r && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
    });
    const board = await capture();
    await click(".asks-btn", "the “need you” button on the phone", { touch: true });
    await popoverOpen(".asks-btn", ".asks");
    const list = await capture();
    return compose(phoneCanvas(board, list));
  },

  async "07-landing"() {
    await viewport({ width: W, height: H });
    await goto("/");
    await waitFor("the landing page's headline (.landing-hero h1)", () => !!document.querySelector(".landing-hero h1")?.textContent?.trim());
    await waitFor("the landing page's link to the demo board", () => !!document.querySelector('.landing a[href$="/demo"]'));
    // The sign-in button reads "Checking you're human…" until Turnstile answers. That's a
    // half-loaded page, so wait it out. If Turnstile won't pass a headless Chrome, skip this
    // shot: --only 01,02,03,04,05,06,thumb
    await waitFor("the sign-in form's human check to finish (the button still says it's checking; skip this shot with --only 01,02,03,04,05,06,thumb)", () => {
      const b = document.querySelector('.landing form button[type="submit"], .landing form button:not([type])');
      return !!b && !/human/i.test(b.textContent);
    });
    return capture();
  },
};

// ── Composed images: the phone canvas and the thumbnail ─────────────────────────────────────

const FONTS = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=JetBrains+Mono:wght@400;600&display=swap">`;

function phoneCanvas(board, list) {
  const dark = scheme !== "light";
  const c = dark
    ? { bg: "#111111", ink: "#e8e8e8", muted: "#9a9a9a", line: "#3a3a3a" }
    : { bg: "#f4f1ea", ink: "#1a1a1a", muted: "#5c5c5c", line: "#c9c4b8" };
  const img = (png) => `data:image/png;base64,${png.toString("base64")}`;
  // 844 tall scaled to 664 leaves 48px above and below; 390 wide comes to 307.
  const ph = 664, pw = Math.round(PHONE.width * ph / PHONE.height);
  return `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>
    * { margin: 0; box-sizing: border-box; }
    html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: ${c.bg}; color: ${c.ink}; font-family: Inter, system-ui, sans-serif; }
    body { display: flex; align-items: center; gap: 56px; padding: 0 72px; }
    .say { flex: 1; min-width: 0; }
    .h { font: 600 15px "JetBrains Mono", ui-monospace, Menlo, monospace; letter-spacing: .08em; color: ${c.muted}; }
    .h b { color: #E85D00; font-weight: 600; }
    h1 { font-size: 44px; line-height: 1.1; font-weight: 700; letter-spacing: -.02em; margin: 18px 0 16px; }
    p { font-size: 19px; line-height: 1.5; color: ${c.muted}; max-width: 26em; }
    .phones { display: flex; gap: 28px; }
    figure { width: ${pw}px; }
    img { display: block; width: ${pw}px; height: ${ph}px; border: 1px solid ${c.line}; }
    figcaption { font: 400 13px "JetBrains Mono", ui-monospace, Menlo, monospace; color: ${c.muted}; margin-top: 10px; }
    figcaption b { color: #E85D00; font-weight: 600; }
  </style></head><body>
    <div class="say">
      <div class="h"><b>//</b> ON_YOUR_PHONE</div>
      <h1>Answer from your phone.</h1>
      <p>It's a web page, so there's nothing to install. The same board, the same questions, the same one list of what's waiting on you.</p>
    </div>
    <div class="phones">
      <figure><img src="${img(board)}" alt=""><figcaption><b>$</b> the board, 390 wide</figcaption></figure>
      <figure><img src="${img(list)}" alt=""><figcaption><b>$</b> need you</figcaption></figure>
    </div>
  </body></html>`;
}

/** Render a page of our own HTML at a fixed size and shoot it. */
async function compose(html, width = W, height = H, dpr = scale) {
  await viewport({ width, height, dpr });
  await send("Page.navigate", { url: "about:blank" });
  await waitFor("a blank page", () => location.href === "about:blank" && document.readyState === "complete");
  const { frameTree } = await send("Page.getFrameTree");
  await send("Page.setDocumentContent", { frameId: frameTree.frame.id, html });
  await waitFor("the composed page's images and fonts", () =>
    [...document.images].every((i) => i.complete && i.naturalWidth > 0) &&
    [...document.querySelectorAll('link[rel="stylesheet"]')].every((l) => l.sheet) &&
    document.fonts.ready.then(() => document.fonts.load('600 15px "JetBrains Mono"')).then(() => true));
  return capture();
}

/** The 240x240 thumbnail: the favicon's own SVG out of index.html, drawn big. */
async function thumbnail() {
  const html = readFileSync(resolve(root, "index.html"), "utf8");
  const m = html.match(/<link rel="icon" href="data:image\/svg\+xml,([^"]+)"/) ?? die("index.html has no inline SVG favicon (<link rel=\"icon\" href=\"data:image/svg+xml,…\">) to draw the thumbnail from.");
  const svg = m[1].replaceAll("%23", "#");
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>
    * { margin: 0; } html, body { width: ${THUMB}px; height: ${THUMB}px; overflow: hidden; }
    svg { display: block; width: ${THUMB}px; height: ${THUMB}px; }
  </style></head><body>${svg}</body></html>`;
  const png = await compose(page, THUMB, THUMB, 1);
  save("thumbnail-240.png", png, THUMB, THUMB);
}

// ── Run ─────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const res = await fetch(`${app}/`).catch(() => null);
  if (!res?.ok) die(`Nothing is answering at ${app}/. Start the app (LOCAL_ONLY=1 npx vite dev --port 5190) or pass its address: npm run shots -- http://localhost:5173`);
  if (!/<title>[^<]*Tasks/.test(await res.text())) die(`${app}/ answered, but it isn't Tasks.`);

  const want = only ? only.split(",").map((s) => s.trim()) : null;
  const names = Object.keys(shots).filter((n) => !want || want.some((w) => n.startsWith(w)));
  if (want && !names.length && !want.includes("thumb")) die(`--only ${only} matches no shot. They are: ${Object.keys(shots).join(", ")}, thumb.`);

  mkdirSync(outDir, { recursive: true });
  await launch();
  if (!want || want.includes("thumb")) await thumbnail();
  for (const name of names) {
    const png = await shots[name]().catch((e) => { if (e instanceof ShotError) e.message = `${name}: ${e.message}`; throw e; });
    save(`${name}.png`, png, W * scale, H * scale);
  }
}

let code = 0;
try {
  await main();
  console.log(written.join("\n"));
} catch (e) {
  if (written.length) console.log(written.join("\n"));
  console.error(`FAIL ${e instanceof ShotError ? e.message : e?.stack ?? e}`);
  code = 1;
} finally {
  quit();
}
process.exit(code);
