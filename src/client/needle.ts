// The local assistant: Needle 3 running in this tab, behind a small hook.
//
// `useNeedle()` starts the worker the first time it's asked to, reports where the load is,
// and turns a message into board tool calls through the shared resolver. Anything it isn't
// sure about comes back as `{ ok: false }` and the caller sends the message to the big model.

import { useCallback, useEffect, useRef, useState } from "react";
import { buildNeedleTools, looksSimple, NEEDLE_THRESHOLD, resolveEnvelope, type NeedleEnvelope, type Resolution } from "../needle-tools";
import type { Board } from "../shared";

export type NeedleStatus =
  | { state: "off" }
  | { state: "loading"; progress: number | null }
  | { state: "ready"; mode: string; cached: boolean }
  | { state: "failed"; error: string };

type Pending = { resolve(v: { envelope: NeedleEnvelope; ms: number }): void; reject(e: Error): void };

/** Whether this browser can run it at all: module workers, wasm, and Cache Storage. */
export const needleSupported = () =>
  typeof Worker !== "undefined" && typeof WebAssembly !== "undefined" && typeof caches !== "undefined";

export function useNeedle(enabled: boolean) {
  const [status, setStatus] = useState<NeedleStatus>({ state: "off" });
  const worker = useRef<Worker | null>(null);
  const pending = useRef(new Map<number, Pending>());
  const seq = useRef(0);

  useEffect(() => {
    if (!enabled || worker.current || !needleSupported()) return;
    let w: Worker;
    try {
      w = new Worker(new URL("./needle.worker.ts", import.meta.url), { type: "module" });
    } catch (e) {
      setStatus({ state: "failed", error: (e as Error).message });
      return;
    }
    worker.current = w;
    setStatus({ state: "loading", progress: null });
    w.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "progress") setStatus({ state: "loading", progress: m.total ? m.got / m.total : null });
      else if (m.type === "ready") setStatus({ state: "ready", mode: m.mode, cached: m.cached });
      else if (m.type === "result") { pending.current.get(m.id)?.resolve({ envelope: m.envelope, ms: m.ms }); pending.current.delete(m.id); }
      else if (m.type === "error") {
        const p = pending.current.get(m.id);
        if (p) { p.reject(new Error(m.error)); pending.current.delete(m.id); }
        else setStatus({ state: "failed", error: m.error });
      }
    };
    w.onerror = (e) => setStatus({ state: "failed", error: e.message || "the local model failed to start" });
    w.postMessage({ id: 0, type: "load" });
    return () => { w.terminate(); worker.current = null; };
  }, [enabled]);

  /**
   * Try a message locally. Returns the resolution, plus the engine's timing and reasoning
   * for the chat to show. Never throws: a worker error reads as "not handled here".
   */
  const run = useCallback(async (board: Board, text: string): Promise<Resolution & { ms?: number; reasoning?: string }> => {
    const w = worker.current;
    if (!w || status.state !== "ready") return { ok: false, reason: "local model not ready", confidence: 0 };
    if (!looksSimple(text)) return { ok: false, reason: "not a one-step command", confidence: 0 };
    const now = new Date();
    const today = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(now);
    const set = buildNeedleTools(board, today, weekday);
    const id = ++seq.current;
    try {
      const r = await new Promise<{ envelope: NeedleEnvelope; ms: number }>((resolve, reject) => {
        pending.current.set(id, { resolve, reject });
        w.postMessage({ id, type: "run", key: set.key, system: set.system, tools: JSON.stringify(set.tools), text });
        setTimeout(() => { if (pending.current.has(id)) { pending.current.delete(id); reject(new Error("timed out")); } }, 8000);
      });
      return { ...resolveEnvelope(r.envelope, board, text, today, NEEDLE_THRESHOLD), ms: r.ms, reasoning: r.envelope.reasoning };
    } catch (e) {
      return { ok: false, reason: (e as Error).message, confidence: 0 };
    }
  }, [status.state]);

  return { status, run };
}
