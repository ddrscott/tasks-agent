// Needle 3 in a Web Worker: the engine and the weights load once, off the page's thread,
// and answer one command at a time. Same recipe as the needle-rs demo (web/worker.js there):
// the relaxed-SIMD build when the browser fuses multiply-add exactly, the exact build otherwise;
// the weights from Hugging Face at a pinned revision, checked by SHA-256, kept in Cache Storage.

const MODEL_REV = "b274efcb211a9eef48c9a88da4b43bd569696a39";
const MODEL_URL = `https://huggingface.co/Cactus-Compute/needle3/resolve/${MODEL_REV}/needle3.cact`;
const MODEL_SHA256 = "c9d915eca282ed42d1a09b143b592adb4cc6744ffe2d294adf5cfc5548170c38";
const MODEL_CACHE = "tasks-needle-model-v1";
// The engine files are vendored from needle-rs under public/tasks/needle/, so they're served
// as plain assets next to the app.
const PKG_BASE = "/tasks/needle";

type Engine = {
  Needle: new (bytes: Uint8Array) => { init(key: string, system: string, tools: string): number; complete(input: string, max: number): string; reset(): void };
  maddFused(): boolean;
  default(): Promise<unknown>;
};

let needle: InstanceType<Engine["Needle"]> | null = null;
let currentKey = "";
let queue: Promise<unknown> = Promise.resolve();

const post = (msg: Record<string, unknown>) => (self as unknown as Worker).postMessage(msg);

async function loadEngine(): Promise<{ m: Engine; mode: string }> {
  try {
    const m = (await import(/* @vite-ignore */ `${PKG_BASE}/pkg-relaxed/needle_wasm.js`)) as Engine;
    await m.default();
    if (m.maddFused()) return { m, mode: "relaxed" };
  } catch {
    // No relaxed SIMD here; the exact build follows.
  }
  const m = (await import(/* @vite-ignore */ `${PKG_BASE}/pkg/needle_wasm.js`)) as Engine;
  await m.default();
  return { m, mode: "exact" };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchModel(): Promise<{ bytes: Uint8Array; cached: boolean }> {
  const cache = await caches.open(MODEL_CACHE).catch(() => null);
  const hit = cache && (await cache.match(MODEL_URL));
  if (hit) return { bytes: new Uint8Array(await hit.arrayBuffer()), cached: true };
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`model download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 35_335_380;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    post({ type: "progress", got, total });
  }
  const bytes = new Uint8Array(got);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.length; }
  if ((await sha256(bytes)) !== MODEL_SHA256) throw new Error("the downloaded model doesn't match the pinned revision");
  if (cache) await cache.put(MODEL_URL, new Response(bytes, { headers: { "content-type": "application/octet-stream" } })).catch(() => {});
  return { bytes, cached: false };
}

async function load() {
  const t0 = performance.now();
  const [{ m, mode }, model] = await Promise.all([loadEngine(), fetchModel()]);
  const t1 = performance.now();
  needle = new m.Needle(model.bytes);
  post({ type: "ready", mode, cached: model.cached, bytes: model.bytes.length, fetchMs: Math.round(t1 - t0), loadMs: Math.round(performance.now() - t1) });
}

self.onmessage = (e: MessageEvent<{ id: number; type: string; key?: string; system?: string; tools?: string; text?: string }>) => {
  const msg = e.data;
  queue = queue.then(async () => {
    try {
      if (msg.type === "load") { await load(); return; }
      if (msg.type === "run") {
        if (!needle) throw new Error("engine not loaded");
        if (msg.key !== currentKey) { needle.init(msg.key!, msg.system!, msg.tools!); currentKey = msg.key!; }
        needle.reset();
        const t = performance.now();
        const envelope = JSON.parse(needle.complete(msg.text!, 120));
        post({ id: msg.id, type: "result", envelope, ms: Math.round(performance.now() - t) });
      }
    } catch (err) {
      post({ id: msg.id, type: "error", error: String((err as Error).message ?? err) });
    }
  });
};
