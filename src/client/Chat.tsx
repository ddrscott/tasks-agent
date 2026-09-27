import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useEffect, useRef, useState } from "react";
import type { Usage } from "../billing";
import { IconClose, IconSend, IconStop } from "./icons";
import { useNeedle } from "./needle";
import type { Board } from "../shared";

const SUGGESTIONS = [
  "Add groceries, call the dentist, and file taxes by Friday",
  "I finished the first thing on my list",
  "What's due this week?",
  "Plan my Saturday: laundry, gym, and meal prep",
];

type Props = {
  agent: Parameters<typeof useAgentChat>[0]["agent"];
  board: Board | null;
  open: boolean;
  model: string;
  onClose(): void;
  onBusy(busy: boolean): void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  usage: Usage | null;
  onUpgrade(): void;
};

type ToolOutput = { ok?: boolean; summary?: string };

function engineTitle(status: ReturnType<typeof useNeedle>["status"], model: string, last: { path: string; note: string } | null): string {
  const head = status.state === "ready" ? `Needle 3 runs in this tab (${status.mode} build${status.cached ? ", cached" : ""}): plain one-step commands are handled here, free, in about a quarter second. ${model} handles the rest.`
    : status.state === "failed" ? `The local model couldn't load (${status.error}); ${model} handles everything.`
    : status.state === "loading" ? "The local model is downloading (35 MB, once); until it's here, the cloud model handles everything."
    : `Cloudflare Workers AI model ${model}.`;
  return last ? `${head}\nLast message: ${last.path === "local" ? "handled in this tab" : "sent to the cloud model"} (${last.note}).` : head;
}

export function Chat({ agent, board, open, model, onClose, onBusy, inputRef, usage, onUpgrade }: Props) {
  const { messages, sendMessage, status, stop, clearHistory, error } = useAgentChat({
    agent,
    body: () => ({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  });
  const [text, setText] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  // The local model loads once the chat has been opened; until then the big model does everything.
  const [wanted, setWanted] = useState(false);
  useEffect(() => { if (open) setWanted(true); }, [open]);
  const needle = useNeedle(wanted);
  const [localBusy, setLocalBusy] = useState(false);
  const [last, setLast] = useState<{ path: "local" | "model"; note: string } | null>(null);
  const busy = status === "submitted" || status === "streaming" || localBusy;
  const capped = !!usage && usage.used >= usage.limit;
  const localReady = needle.status.state === "ready";
  const canUpgrade = !!usage?.billing && usage.plan === "free";

  useEffect(() => onBusy(busy), [busy, onBusy]);
  useEffect(() => {
    if (!text && inputRef.current) inputRef.current.style.height = "";
  }, [text, inputRef]);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, status]);

  async function send(t: string) {
    const v = t.trim();
    if (!v || busy || (capped && !localReady)) return;
    setText("");
    // First the model in this tab: free, a quarter second, and only when it's sure. Then the big one.
    if (localReady && board) {
      setLocalBusy(true);
      try {
        const r = await needle.run(board, v);
        if (r.ok) {
          const stub = (agent as unknown as { stub: { applyLocal(turn: unknown): Promise<unknown> } }).stub;
          await stub.applyLocal({ text: v, calls: r.calls, engine: "needle-rs", confidence: r.confidence, ms: r.ms });
          setLast({ path: "local", note: `in this tab · ${r.ms ?? "?"} ms · ${Math.round(r.confidence * 100)}% sure` });
          return;
        }
        setLast({ path: "model", note: r.reason });
      } catch {
        setLast({ path: "model", note: "local model error" });
      } finally {
        setLocalBusy(false);
      }
    }
    if (capped) return;
    void sendMessage({ role: "user", parts: [{ type: "text", text: v }] });
  }

  const lastMsg = messages[messages.length - 1];
  const waiting = busy && (lastMsg?.role === "user" || !lastMsg?.parts.some((p) => p.type === "text" && p.text.trim()));

  return (
    <aside className={`chat${open ? "" : " closed"}`} aria-label="Assistant">
      <header className="chat-head">
        <h2 className="h">ASSISTANT</h2>
        <span className="spacer" />
        {messages.length > 0 && <button className="btn ghost" onClick={() => clearHistory()} disabled={busy}>New chat</button>}
        <button className="btn ghost icon" title="Close" onClick={onClose}><IconClose /></button>
      </header>

      <div className="chat-log" ref={logRef} aria-live="polite">
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>Tell me what's on your plate, what you finished, or what changed. I'll update the board.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => <button key={s} className="suggestion" onClick={() => send(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {messages.map((m) =>
          m.parts.map((part, i) => {
            const key = `${m.id}-${i}`;
            if (part.type === "text") {
              return part.text.trim() ? <div key={key} className={`msg ${m.role}`}>{part.text.trim()}</div> : null;
            }
            if (part.type.startsWith("tool-") && "state" in part) {
              if (part.state === "output-available") {
                const out = (part.output ?? {}) as ToolOutput;
                return (
                  <div key={key} className={`tool-line${out.ok === false ? " fail" : ""}`}>
                    <span className="mark">{out.ok === false ? "✗" : "✓"}</span>
                    <span>{out.summary ?? "Done"}</span>
                  </div>
                );
              }
              if (part.state === "output-error") {
                return <div key={key} className="tool-line fail"><span className="mark">✗</span><span>{String(part.errorText ?? "That didn't work")}</span></div>;
              }
              return <div key={key} className="tool-line run"><span className="mark">$</span><span>updating the board…</span></div>;
            }
            return null;
          }),
        )}
        {waiting && <div className="working">thinking</div>}
        {error && !capped && <div className="msg error">Something went wrong: {error.message}</div>}
        {capped && (
          <div className="cap-note" role="status">
            <p>
              <b>That's today's {usage.limit} assistant messages.</b> The board, drag and drop, and connected
              agents keep working{localReady ? ", and so do plain commands like \"finished the taxes\", which the model in this tab handles for free" : ""}. The count resets at midnight UTC.
            </p>
            {canUpgrade && <button className="btn primary" onClick={onUpgrade}>Upgrade to Pro</button>}
          </div>
        )}
      </div>

      <div className="composer">
        <form className="composer-box" onSubmit={(e) => { e.preventDefault(); send(text); }}>
          <span className="prompt">$</span>
          <textarea
            ref={inputRef} rows={1} value={text} placeholder="Tell me what changed…" aria-label="Message the assistant"
            onChange={(e) => {
              setText(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); }
              if (e.key === "Escape") e.currentTarget.blur();
            }}
          />
          {busy ? (
            <button type="button" className="btn icon" title="Stop" onClick={() => stop()}><IconStop /></button>
          ) : (
            <button className="btn primary icon" title="Send" disabled={!text.trim() || (capped && !localReady)}><IconSend /></button>
          )}
        </form>
        <div className="foot">
          <span className="engine" title={engineTitle(needle.status, model, last)}>
            <span className="prompt">$</span>{" "}
            {needle.status.state === "ready" ? `needle-rs in this tab · ${model.split("/").pop()} behind it`
              : needle.status.state === "loading" ? `loading the local model${needle.status.progress != null ? ` ${Math.round(needle.status.progress * 100)}%` : "…"}`
              : model.split("/").pop()}
            {last && <span className="path"> · last: {last.path === "local" ? "this tab" : "cloud"}</span>}
          </span>
          {usage ? (
            <span className={`meter${capped ? " full" : ""}`} title={`${usage.plan === "pro" ? "Pro" : "Free"} plan · ${model.split("/").pop()}`}>
              {usage.used}/{usage.limit} today{usage.plan === "pro" ? " · pro" : ""}
            </span>
          ) : (
            <span title="Cloudflare Workers AI model">{model.split("/").pop()}</span>
          )}
        </div>
      </div>
    </aside>
  );
}
