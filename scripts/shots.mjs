#!/usr/bin/env node
// Makes the Product Hunt gallery: six 1270x760 images in docs/launch/gallery/, each one a crop
// of the running app set on a dark canvas with a `// KICKER` and a headline. Run it with
// `npm run shots` while a dev server (or the live site) is up.
//
//   node scripts/shots.mjs [base-url] [--only 03,06] [--scale 1|2]
//
// base-url defaults to http://localhost:5190 (TASKS_SHOTS_URL also sets it). It drives the
// Chrome in /Applications over the DevTools protocol with Node's own WebSocket, so there's
// nothing to install; CHROME=/path/to/chrome points it at another Chrome or Chromium. That
// Chrome is headless and gets a throwaway profile in the temp folder (--user-data-dir), so it
// never touches the Chrome you're signed in to.
//
// 01 to 04 and 06 are the signed-out demo board. 05 is the quick start's command on a new account's
// board: the script signs up with a made-up address and the code a dev server shows on screen,
// so 05 only comes from a dev server (DEV_LOGIN_CODES=1), never from the live site.
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
const scheme = "dark";   // the canvas is dark, so the app is too
const only = flag("only", "");
const scale = Number(flag("scale", "2"));
if (args.includes("--help") || args.includes("-h")) {
  console.log("usage: node scripts/shots.mjs [base-url] [--only 03,06] [--scale 1|2]");
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
  // The quick-start shot copies a command. Headless Chrome has no focused window and no
  // clipboard permission until it's told otherwise.
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
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
  try { proc?.kill("SIGKILL"); } catch {}
  // Chrome can still be letting go of its files for a moment after it's killed.
  if (profile) try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
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

// ── Crops ───────────────────────────────────────────────────────────────────────────────────

/** Mark the element a page function finds, so a selector can reach it. Returns the selector. */
async function mark(what, fn, ...a) {
  const tag = `m${++nextId}`;
  await waitFor(what, `(tag, ...rest) => { const el = (${fn})(...rest); if (!el) return false; el.setAttribute("data-shot", tag); return true; }`, tag, ...a);
  return `[data-shot="${tag}"]`;
}

/** Where things are on the page, in CSS pixels: the box around every element the selectors match. */
async function boxAround(selectors, pad = 0) {
  const r = await inPage((sels) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of sels) for (const el of document.querySelectorAll(s)) {
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      x0 = Math.min(x0, b.left); y0 = Math.min(y0, b.top); x1 = Math.max(x1, b.right); y1 = Math.max(y1, b.bottom);
    }
    return x1 > x0 ? { x0, y0, x1, y1, vw: innerWidth, vh: innerHeight } : null;
  }, selectors);
  if (!r) die(`Nothing on screen matches ${selectors.join(", ")}.`);
  return even({
    x: Math.max(0, r.x0 - pad), y: Math.max(0, r.y0 - pad),
    width: Math.min(r.vw, r.x1 + pad) - Math.max(0, r.x0 - pad),
    height: Math.min(r.vh, r.y1 + pad) - Math.max(0, r.y0 - pad),
  });
}

/** Whole pixels, and an even width and height, so a crop shot at 2.5x still lands on whole device pixels. */
const even = ({ x, y, width, height }) => {
  const x1 = Math.ceil(x + width), y1 = Math.ceil(y + height);
  x = Math.floor(x); y = Math.floor(y);
  width = x1 - x; height = y1 - y;
  return { x, y, width: width + (width % 2), height: height + (height % 2) };
};

/**
 * Hide everything but these elements, without moving anything. An element cropped to its own
 * edges sits at a fractional position, so the crop takes in up to a pixel of what's behind it;
 * this makes that pixel plain background instead of a sliver of the board.
 */
async function isolate(selectors) {
  await inPage((sels) => {
    const s = document.createElement("style");
    s.textContent = `body * { visibility: hidden !important } ${sels.flatMap((x) => [x, `${x} *`]).join(", ")} { visibility: visible !important } dialog::backdrop { background: #1a1a1a !important; backdrop-filter: none !important }`;
    document.head.append(s);
    return true;
  }, selectors);
}

/**
 * Shoot one rectangle of the page, big enough to be drawn `zoom` times its size on the canvas
 * without going soft. The viewport's size stays put; only its pixel density changes, so nothing
 * on the page moves between measuring and shooting.
 */
async function crop(rect, zoom, vp) {
  if (rect.y + rect.height > vp.height || rect.x + rect.width > vp.width) die(`The crop ${JSON.stringify(rect)} runs off the ${vp.width}x${vp.height} screen.`);
  await viewport({ ...vp, dpr: scale * zoom });
  await settle();
  const { data } = await send("Page.captureScreenshot", { format: "png", clip: { ...rect, scale: 1 } });
  return { src: `data:image/png;base64,${data}`, w: Math.round(rect.width * zoom), h: Math.round(rect.height * zoom) };
}

/** The biggest zoom, in quarter steps, that fits a rect in a box. */
const fit = (rect, boxW, boxH, max = 2) => {
  const z = Math.floor(Math.min(boxW / rect.width, boxH / rect.height, max) * 4) / 4;
  if (z < 0.75) die(`A ${rect.width}x${rect.height} crop would have to shrink to ${z}x to fit ${boxW}x${boxH}; its text would be too small to read.`);
  return z;
};

// ── The canvas every image is set on ────────────────────────────────────────────────────────
//
// 1270x760, dark, square corners. A `// KICKER`, a headline, one line under it, and the crop
// of the real app. `side` puts the words on the left and the crop on the right; `top` puts the
// words across the top and lets the crop run off the bottom edge.

const FONTS = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap">`;
const INK = { bg: "#1a1a1a", ink: "#f0f0f0", muted: "#a0a0a0", line: "#3d3d3d", accent: "#E85D00" };
const PAD = 56;            // the canvas's margin
const SIDE_TEXT = 470;     // width of the words in a `side` layout
const SIDE_GAP = 56;
const TOP_BAND = 196;      // height of the words in a `top` layout
const HEADLINE_ONLY = 150; // and with no line under the headline
const STACK_GAP = 10;      // between a top-bar button and the list under it
/** Room for the crop in a `side` layout. */
const SIDE_BOX = { w: W - PAD * 2 - SIDE_TEXT - SIDE_GAP, h: H - 48 * 2 };
/** Width of the crop in a `top` layout, borders included. */
const TOP_W = W - PAD * 2;

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/**
 * @param {{ layout: "side" | "top", kicker: string, headline: string, sub?: string,
 *           art: string, bleed?: boolean }} o  `art` is HTML; `bleed` runs it off the bottom edge.
 */
function canvas({ layout, kicker, headline, sub, art, bleed = false }) {
  const c = INK;
  return `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>
    * { margin: 0; box-sizing: border-box; }
    html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: ${c.bg}; color: ${c.ink}; font-family: Inter, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
    body { position: relative; }
    .mono { font-family: "JetBrains Mono", ui-monospace, Menlo, monospace; }
    .k { font: 600 17px "JetBrains Mono", ui-monospace, Menlo, monospace; letter-spacing: .08em; color: ${c.muted}; white-space: nowrap; }
    .k b, .at b { color: ${c.accent}; font-weight: 600; }
    h1 { font-weight: 700; letter-spacing: -.025em; text-wrap: balance; }
    p { color: ${c.muted}; text-wrap: pretty; }
    .at { font: 400 15px "JetBrains Mono", ui-monospace, Menlo, monospace; color: ${c.muted}; white-space: nowrap; }
    .shot { border: 1px solid ${c.line}; background: ${c.bg}; }
    .shot img { display: block; }
    .bare { border: 0; }
    .stack { display: flex; flex-direction: column; align-items: flex-end; gap: ${STACK_GAP}px; }

    .side .say { position: absolute; left: ${PAD}px; top: 0; bottom: 0; width: ${SIDE_TEXT}px; display: flex; flex-direction: column; justify-content: center; }
    .side h1 { font-size: 50px; line-height: 1.08; margin: 20px 0 20px; }
    .side p { font-size: 22px; line-height: 1.45; }
    .side .at { position: absolute; left: ${PAD}px; bottom: 44px; }
    .side .art { position: absolute; left: ${PAD + SIDE_TEXT + SIDE_GAP}px; right: ${PAD}px; top: 0; bottom: 0; display: flex; align-items: center; justify-content: center; }
    .side .art.bleed { align-items: flex-end; }

    .top .say { position: absolute; left: ${PAD}px; right: ${PAD}px; top: 40px; }
    .top h1 { font-size: 46px; line-height: 1.1; margin: 14px 0 12px; white-space: nowrap; }
    .top p { font-size: 22px; line-height: 1.4; white-space: nowrap; }
    .top .at { position: absolute; right: ${PAD}px; top: 42px; }
    .top .art { position: absolute; left: ${PAD}px; right: ${PAD}px; top: ${TOP_BAND}px; bottom: 0; display: flex; align-items: center; justify-content: center; }
    .top .art.bleed { align-items: flex-end; }
    .bleed .shot { border-bottom: 0; }

    .phone { border: 1px solid ${c.line}; background: #0d0d0d; padding: 34px 12px 0; border-radius: 2px; position: relative; }
    .phone::before { content: ""; position: absolute; top: 14px; left: 50%; width: 64px; height: 6px; margin-left: -32px; background: ${c.line}; }
    .phone .shot { border-bottom: 0; }
  </style></head><body class="${layout}">
    <div class="say">
      <div class="k"><b>//</b> ${esc(kicker)}</div>
      <h1>${esc(headline).replace(/\n/g, "<br>")}</h1>
      ${sub ? `<p>${esc(sub)}</p>` : ""}
    </div>
    <div class="at"><b>$</b> askscottpierce.com/tasks</div>
    <div class="art${bleed ? " bleed" : ""}">${art}</div>
  </body></html>`;
}

const bareImg = (c) => `<div class="shot bare"><img src="${c.src}" width="${c.w}" height="${c.h}" alt=""></div>`;
const shotImg = (c) => `<div class="shot"><img src="${c.src}" width="${c.w}" height="${c.h}" alt=""></div>`;

/** After the canvas is drawn: nothing in it may be clipped by accident or wrap where it shouldn't. */
async function composed(name, o) {
  const png = await compose(canvas(o));
  const bad = await inPage((bleed) => {
    const out = [];
    const say = document.querySelector(".say").getBoundingClientRect();
    const art = document.querySelector(".art .shot, .art .phone").getBoundingClientRect();
    if (say.right > innerWidth || say.bottom > innerHeight) out.push("the words run off the canvas");
    for (const el of document.querySelectorAll(".say *")) if (el.scrollWidth > el.clientWidth + 1) out.push(`“${el.textContent.trim().slice(0, 40)}” is wider than its column`);
    if (art.left < 0 || art.right > innerWidth || art.top < 0) out.push("the picture runs off the canvas");
    if (!bleed && art.bottom > innerHeight) out.push("the picture runs off the bottom of the canvas");
    if (bleed && art.bottom < innerHeight) out.push("the picture was meant to run off the bottom edge and stops short of it");
    if (document.body.classList.contains("top") && say.bottom > art.top - 16) out.push("the words sit on top of the picture");
    return out.join("; ");
  }, !!o.bleed);
  if (bad) die(`the canvas for ${name} doesn't fit: ${bad}.`);
  return png;
}

// ── The shots, in gallery order ─────────────────────────────────────────────────────────────

const DESK = { width: W, height: H };

/**
 * A top-bar button and the list it opens, each cropped to its own edges and set one above the
 * other the way the app draws them, so none of the board behind shows through in slivers.
 */
async function listShot(button, body, ready) {
  await viewport(DESK);
  await demo();
  await click(button, `the ${button} button in the top bar`);
  await popoverOpen(button, body);
  await ready();
  const fits = await inPage((s) => { const el = document.querySelector(s); return el.scrollHeight <= el.clientHeight + 1; }, body);
  if (!fits) die(`the ${body} list is taller than its box at ${DESK.width}x${DESK.height}, so a crop would cut it mid-row.`);
  const pop = `.popover:has(> ${body})`;
  await isolate([button, pop]);
  const btn = await boxAround([button]), list = await boxAround([pop]);
  const zoom = fit({ width: list.width, height: btn.height + list.height }, SIDE_BOX.w, SIDE_BOX.h - STACK_GAP, 1.75);
  const b = await crop(btn, zoom, DESK), l = await crop(list, zoom, DESK);
  return `<div class="stack">${bareImg(b)}${bareImg(l)}</div>`;
}

const shots = {
  // The board with an agent's question on a card. The first image is the one that gets shared.
  async "01-board-question"() {
    // The board is shot as wide as it's drawn, so it's pixel for pixel.
    const vp = { width: TOP_W - 2, height: H };
    await viewport(vp);
    const id = await demo();
    await waitFor("the “need you” count in the top bar", () => /\d/.test(document.querySelector(".asks-btn")?.textContent ?? ""));
    // The frame ends on the canvas's bottom edge. The whole question card has to be above it.
    const rect = even({ x: 0, y: 0, width: vp.width, height: H - TOP_BAND });
    const cardBottom = await inPage((i) => document.querySelector(`[data-card-id="${i}"]`).getBoundingClientRect().bottom, id);
    if (cardBottom > rect.height - 12) die(`the question card ends at ${Math.round(cardBottom)}px, below the ${rect.height}px of board the first image shows.`);
    return composed("01", {
      layout: "top", bleed: true,
      kicker: "TASKS", headline: "The task board your coding agents work from.",
      sub: "They pick up cards over MCP. When one needs a decision, it asks on the card.",
      art: shotImg(await crop(rect, 1, vp)),
    });
  },

  // “What needs me”: only the list.
  async "02-need-you"() {
    const art = await listShot(".asks-btn", ".asks", () => waitFor("an answer button in the “need you” list", () => !!document.querySelector(".asks .ask-opt")));
    return composed("02", {
      layout: "side",
      kicker: "NEEDS_YOU", headline: "Everything waiting\non you, in one list.",
      sub: "Every open question, and every Claude Code session stopped at a prompt. One tap answers.",
      art,
    });
  },

  // “What are my agents doing”: only the Sessions list.
  async "03-sessions"() {
    const art = await listShot(".sess-btn", ".sessions", () => waitFor("at least two projects in the Sessions list", () => document.querySelectorAll(".sessions .sess-project").length >= 2));
    return composed("03", {
      layout: "side",
      kicker: "SESSIONS", headline: "What every session is doing, by project.",
      sub: "Claude Code sessions on any machine: working, waiting on you, or idle, and the last thing each one did.",
      art,
    });
  },

  // One open card, from its top down to the end of a notes row. The cut is the canvas's edge.
  async "04-card"() {
    // A tall screen, so the dialog lays out all of its notes and nothing is scrolled.
    const vp = { width: W, height: 1500 };
    await viewport(vp);
    const id = await demo();
    // Enter on a focused card opens it. A click in the middle of this one would land on an answer.
    await inPage((i) => document.querySelector(`[data-card-id="${i}"]`).focus(), id);
    await key("Enter");
    await waitFor("the open card's notes rendered as markdown (.dialog-body .md)", () => !!document.querySelector(".dialog-body .md"));
    await waitFor("a STATUS line in the open card's notes", () => /STATUS:/.test(document.querySelector(".dialog-body .md")?.textContent ?? ""));
    await waitFor("a checklist in the open card's notes", () => document.querySelectorAll('.dialog-body .md input[type="checkbox"]').length >= 2);
    await waitFor("the claiming session's row in the open card (Copy resume command)", () => !!document.querySelector(".dialog-body .sess-resume"));
    await isolate(["dialog.card-dialog"]);
    await inPage(() => {
      document.activeElement?.blur?.();
      document.querySelector(".dialog-body").scrollTop = 0;
      return true;
    });
    const zoom = 1;
    const room = (H - 40) / zoom;   // how much of the dialog the canvas shows, top to bottom edge
    // The cut goes in the gap under the last row of notes that fits: a paragraph, a heading, or
    // a checklist line, never through one.
    const at = await inPage((room) => {
      const dlg = document.querySelector("dialog.card-dialog").getBoundingClientRect();
      const md = document.querySelector(".dialog-body .md");
      const rows = [...md.querySelectorAll("p, h1, h2, h3, h4, li, pre")].filter((el) => !el.querySelector("p, li, pre")).map((el) => el.getBoundingClientRect());
      const limit = dlg.top + room;
      let cut = 0;
      rows.forEach((r, i) => {
        const next = rows[i + 1];
        const gap = next ? (r.bottom + next.top) / 2 : r.bottom + 10;
        if (gap <= limit) cut = gap;
      });
      const checks = [...md.querySelectorAll('input[type="checkbox"]')].filter((el) => el.getBoundingClientRect().bottom < cut).length;
      return { x: dlg.left, y: dlg.top, width: dlg.width, cut, checks };
    }, room);
    if (at.checks < 2) die(`only ${at.checks} checklist rows of the open card's notes fit above the cut; the picture is meant to show the checklist.`);
    const rect = even({ x: at.x, y: at.y, width: at.width, height: Math.round(at.cut - at.y) });
    const c = await crop(rect, zoom, vp);
    return composed("04", {
      layout: "side", bleed: true,
      kicker: "CARD", headline: "Each card says where it stands.",
      sub: "The session that claimed it, the question it asked, and a STATUS line and checklist the agent keeps current.",
      art: bareImg(c),
    });
  },

  // The command the quick start copies, on a new account's board with the sample card added.
  async "05-quick-start"() {
    let vp = { width: 1180, height: 900 };
    await viewport(vp);
    await signIn();
    // Keyed off structure, not wording: a section labelled by its own heading, holding a list of
    // four steps. Step 2's button adds the sample card, step 3's makes the command.
    const sec = 'section[aria-labelledby="first-run-h"]';
    await waitFor(`the quick start on a new account's empty board (${sec} with a heading and an ordered list of 4 steps)`, (s) => {
      const el = document.querySelector(s);
      return !!el && !!el.querySelector("h2") && el.querySelectorAll("ol > li").length === 4;
    }, sec);
    // The steps are pressed at desktop width, four across, whatever else (the assistant's panel)
    // shares the row. The window is narrowed for the picture further down.
    const want = Math.floor(TOP_W / 1.25 / 2) * 2;
    vp.width += want - (await boxAround([sec])).width;
    await viewport(vp);
    await click(`${sec} ol > li:nth-child(2) button:not(:disabled)`, "an enabled button in the quick start's step 2 (add the sample card)");
    await waitFor("the sample card on the board after step 2's button", () => !!document.querySelector("[data-card-id]"));
    await click(`${sec} ol > li:nth-child(3) button:not(:disabled)`, "an enabled button in the quick start's step 3 (copy the command)");
    await waitFor(`the command under the quick start's steps (${sec} [role=status] pre)`, (s) => /claude /.test(document.querySelector(`${s} [role="status"] pre`)?.textContent ?? ""), sec);
    // The page says something different when the clipboard refuses. The picture is of a copy that worked.
    const copied = await inPage(() => navigator.clipboard.readText().then((t) => /claude /.test(t), () => false));
    if (!copied) die("the command never reached the clipboard, so the page is showing its “copy it from here” fallback.");
    // Once the command is copied the block folds to one line, out of the board's way. The
    // picture is of the four steps, so it opens them again with the block's own button.
    await click(`${sec} button[aria-controls][aria-expanded="false"]`, "the button that shows the quick start's steps again after the copy");
    await waitFor("the quick start's steps to be showing again", (s) => { const li = document.querySelector(`${s} ol > li`); return !!li && li.getBoundingClientRect().height > 0; }, sec);
    // The token is this throwaway account's, on this server. It still doesn't belong in a picture.
    await inPage((s) => {
      const pre = document.querySelector(`${s} [role="status"] pre`);
      const walk = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) n.nodeValue = n.nodeValue.replace(/(Bearer )([^\s'"]{4})[^\s'"]+/, (_, b, head) => `${b}${head}${"•".repeat(28)}`);
      return true;
    }, sec);
    await showHostedOrigin();
    // The toast for the added card would sit over the board; it's not part of this picture.
    await waitFor("the “added a card” toast to go away", () => !document.querySelector(".toast"), undefined);
    const whole = await inPage((s) => { const pre = document.querySelector(`${s} [role="status"] pre`); pre.scrollTop = 0; return pre.scrollHeight <= pre.clientHeight + 1 && /Bearer .{4}•/.test(pre.textContent); }, sec);
    if (!whole) die("the quick start's command is scrolled inside its box or still shows a token; the picture would be wrong.");
    await inPage(() => { scrollTo(0, 0); document.activeElement?.blur?.(); return true; });
    // The picture is the command, big enough to read at the 635px Product Hunt shows a gallery
    // image at before it's clicked. The four steps' small print can't be, at any size that keeps
    // the command in frame, so the canvas's own line says the steps and the crop is the block
    // the copy leaves on the page: the command, its Copy button, and the line about the token.
    // The block is as wide as the page lets it be, so a bigger picture of it means a narrower
    // page: the window is narrowed until the block, drawn at `zoom`, is as wide as the canvas.
    // Under 900px that's the app's own narrow layout, where the block scrolls inside the board,
    // so the window is tall enough that nothing has to.
    const cmd = `${sec} [role="status"]:has(pre)`;
    vp = { width: vp.width, height: 2400 };
    const room = H - TOP_BAND - 28;
    let zoom, at;
    for (zoom of [2, 1.9, 1.8, 1.75, 1.7, 1.6, 1.5, 1.4, 1.25]) {
      const want = Math.floor((TOP_W - 2) / zoom / 2) * 2;
      for (let i = 0; i < 5; i++) {
        await viewport(vp);
        await settle();
        const w = await inPage((s) => Math.round(document.querySelector(s).getBoundingClientRect().width), cmd);
        if (w === want) break;
        vp.width += want - w;
      }
      at = await inPage((s) => {
        const el = document.querySelector(s), pre = el.querySelector("pre");
        el.scrollIntoView({ block: "center" });
        pre.scrollTop = 0;
        const r = el.getBoundingClientRect();
        return { width: Math.round(r.width), height: Math.ceil(r.height), whole: pre.scrollHeight <= pre.clientHeight + 1 && r.top >= 0 && r.bottom <= innerHeight };
      }, cmd);
      if (at.width === want && at.whole && at.height * zoom <= room) break;
      at.fits = false;
    }
    if (at.fits === false) die(`the quick start's command block is ${at.width}x${at.height}px on the page${at.whole ? "" : ", with the command scrolled inside its box"}, and even at ${zoom}x it doesn't fit the ${TOP_W}x${room}px the canvas has for it.`);
    await isolate([cmd]);
    const c = await crop(await boxAround([cmd]), zoom, vp);
    await send("Network.clearBrowserCookies");
    return composed("05", {
      layout: "top",
      kicker: "START_HERE", headline: "Four steps to a working agent.",
      sub: "Sign in, add a sample card, copy this command, paste it in a terminal.",
      art: bareImg(c),
    });
  },

  // The “need you” list on a phone, where an answer is one tap.
  async "06-phone"() {
    const vp = { ...PHONE, mobile: true };
    await viewport(vp);
    await demo();
    // The phone opens on the lane with the question. Behind the list, that card would show the
    // same answers twice, so the board is slid to its first lane before the list opens.
    await inPage(() => { for (const el of document.querySelectorAll(".board, .board *")) if (el.scrollWidth > el.clientWidth + 40) el.scrollLeft = 0; scrollTo(0, 0); return true; });
    await waitFor("the first lane on screen at 390 wide", () => { const r = document.querySelector(".lane-head")?.getBoundingClientRect(); return !!r && r.left >= 0 && r.left < 60; });
    await click(".asks-btn", "the “need you” button on the phone", { touch: true });
    await popoverOpen(".asks-btn", ".asks");
    await waitFor("an answer button in the “need you” list on the phone", () => !!document.querySelector(".asks .ask-opt"));
    // The phone runs off the bottom of the canvas. The whole list has to be above that edge.
    const zoom = 1.25, bezelTop = 34;
    const shown = Math.floor((H - 48 - bezelTop - 1) / zoom);
    const listBottom = await inPage(() => document.querySelector(".popover:has(> .asks)").getBoundingClientRect().bottom);
    if (listBottom > shown - 16) die(`the “need you” list ends at ${Math.round(listBottom)}px on the phone, below the ${shown}px the picture shows.`);
    const c = await crop(even({ x: 0, y: 0, width: PHONE.width, height: shown + 2 }), zoom, vp);
    return composed("06", {
      layout: "side", bleed: true,
      kicker: "ON_YOUR_PHONE", headline: "Answer from your phone in one tap.",
      sub: "It's a web page, so there's nothing to install. The same list of what's waiting on you.",
      art: `<div class="phone">${shotImg(c)}</div>`,
    });
  },
};

/**
 * Sign in as a brand-new account, the way a person does: the landing page's form, an email, and
 * the code a dev server prints on screen (DEV_LOGIN_CODES=1). The live site emails its codes, so
 * this only works against a dev server, and says so.
 */
async function signIn() {
  await send("Network.clearBrowserCookies");
  await goto("/");
  const email = `shots-${Date.now().toString(36)}@example.com`;
  await waitFor("the sign-in form's email field", () => !!document.querySelector('input[type="email"]'));
  await inPage(() => { document.querySelector('input[type="email"]').focus(); return true; });
  await send("Input.insertText", { text: email });
  const submit = await mark("the sign-in form's button to come alive (it waits for the human check)", () => {
    const b = document.querySelector('input[type="email"]').closest("form")?.querySelector("button");
    return b && !b.disabled ? b : null;
  });
  // The human check can still be settling when the button first comes alive, and a click that
  // lands then does nothing. So: click, look, and click again if the form is still there.
  const sent = () => document.querySelector('input[autocomplete="one-time-code"]') ? "ok" : document.querySelector('[role="alert"]')?.textContent?.trim() || "";
  let got = "";
  for (let i = 0; i < 5 && !got; i++) {
    await click(submit, "the sign-in form's button");
    for (let t = 0; t < 30 && !got; t++) { got = await inPage(sent); if (!got) await sleep(100); }
  }
  if (!got) die("the sign-in form never moved on to its code field, and gave no reason.");
  if (got !== "ok") die(`the sign-in form refused a new account: “${got}”`);
  await sleep(300);
  const code = await inPage(() => {
    const card = document.querySelector('input[autocomplete="one-time-code"]').closest("form").parentElement;
    return card.textContent.match(/(?<!\d)\d{6}(?!\d)/)?.[0] ?? "";
  });
  if (!code) die(`${base} doesn't show sign-in codes on screen, so the script can't sign in for the quick-start picture. Shoot this one from a dev server: npm run shots -- http://localhost:5190 --only 05`);
  await inPage(() => { document.querySelector('input[autocomplete="one-time-code"]').focus(); return true; });
  await send("Input.insertText", { text: code });
  const go = await mark("the code form's button", () => {
    const b = document.querySelector('input[autocomplete="one-time-code"]')?.closest("form")?.querySelector("button");
    return b && !b.disabled ? b : null;
  }).catch(() => null);
  // Some builds sign in the moment the sixth digit lands; then there's no button left to press.
  if (go && await inPage((s) => !!document.querySelector(s), go)) await click(go, "the code form's button");
  await waitFor("the board after signing in", () => !!document.querySelector(".board, .lane, [class*=lane]") && !document.querySelector('input[autocomplete="one-time-code"]'));
}

// ── Composed images: the canvas and the thumbnail ───────────────────────────────────────────

/** Render a page of our own HTML at a fixed size and shoot it. */
async function compose(html, width = W, height = H, dpr = scale) {
  await viewport({ width, height, dpr, mobile: false });
  // The canvas's fonts come over the network. A slow answer gets a second and a third try
  // before the run fails, and the failure says which part never arrived.
  for (let attempt = 1; ; attempt++) {
    await send("Page.navigate", { url: "about:blank" });
    await waitFor("a blank page", () => location.href === "about:blank" && document.readyState === "complete");
    const { frameTree } = await send("Page.getFrameTree");
    await send("Page.setDocumentContent", { frameId: frameTree.frame.id, html });
    let missing = "";
    for (const until = Date.now() + 8000; Date.now() < until; await sleep(100)) {
      missing = await inPage(() => {
        if (![...document.images].every((i) => i.complete && i.naturalWidth > 0)) return "its pictures";
        if (![...document.querySelectorAll('link[rel="stylesheet"]')].every((l) => l.sheet)) return "the font stylesheet from fonts.googleapis.com";
        if (!document.querySelector('link[rel="stylesheet"]')) return "";   // the thumbnail has no words
        return Promise.race([
          document.fonts.ready.then(() => Promise.all([document.fonts.load('700 46px Inter'), document.fonts.load('600 15px "JetBrains Mono"')])).then((f) => f.every((x) => x.length) ? "" : "Inter or JetBrains Mono"),
          new Promise((r) => setTimeout(() => r("the font files"), 3000)),
        ]);
      });
      if (!missing) return capture();
    }
    if (attempt === 3) die(`the composed page never finished loading ${missing} (three tries).`);
  }
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
