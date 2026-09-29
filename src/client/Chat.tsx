import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useEffect, useRef, useState } from "react";
import type { Usage } from "../billing";
import { IconClose, IconSend, IconStop } from "./icons";
import { useNeedle } from "./needle";
import type { LocalCall } from "../needle-tools";
import { clean, hasSealedText, type Board } from "../shared";
import type { Vault } from "./vault";

const SUGGESTIONS = [
  "Add groceries, call the dentist, and file taxes by Friday",
  "I finished the first thing on my list",
  "What's due this week?",
  "Plan my Saturday: laundry, gym, and meal prep",
];

// On an encrypted board the cloud model can't read anything, so only the model in this tab runs.
const SEALED_SUGGESTIONS = ["Add groceries due tomorrow", "Add call the dentist"];

/** Encrypt the text in a local turn's tool calls. Ids and lane ids stay as they are; the server moves things by id. */
async function sealCall(vault: Vault, c: LocalCall): Promise<LocalCall> {
  const input = c.input as Record<string, unknown>;
  const opt = async (v: unknown, f = (x: string) => x) => (typeof v === "string" && v ? vault.seal(f(v)) : v);
  if (c.name === "add_cards") {
    const cards = input.cards as Record<string, unknown>[];
    return { name: c.name, input: { cards: await Promise.all(cards.map(async (k) => ({ ...k, title: await opt(k.title, (t) => clean(t, 200)), notes: await opt(k.notes), due: await opt(k.due) }))) } };
  }
  if (c.name === "update_card") {
    return { name: c.name, input: { ...input, title: await opt(input.title, (t) => clean(t, 200)), notes: await opt(input.notes), due: await opt(input.due) } };
  }
  return c;
}

/** A chat line with any encrypted text in it decrypted, once the vault gets to it. */
function Plain({ text, vault }: { text: string; vault: Vault | null }) {
  const [shown, setShown] = useState(() => (vault ? vault.revealKnown(text) : text));
  useEffect(() => {
    if (vault && hasSealedText(text)) void vault.reveal(text).then(setShown);
    else setShown(text);
  }, [text, vault]);
  return <>{shown}</>;
}

type Props = {
  agent: Parameters<typeof useAgentChat>[0]["agent"];
  board: Board | null;
  /** Set on an encrypted board. */
  vault: Vault | null;
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

export function Chat({ agent, board, vault, open, model, onClose, onBusy, inputRef, usage, onUpgrade }: Props) {
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
  const [notice, setNotice] = useState<string | null>(null);
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
    if (!v || busy) return;
    setNotice(null);
    if (vault) return sendSealed(v);
    if (capped && !localReady) return;
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

  /** An encrypted board: the model in this tab or nothing. The message and the tool calls go out encrypted. */
  async function sendSealed(v: string) {
    if (!board || !vault) return;
    if (!localReady) {
      setNotice(needle.status.state === "failed"
        ? `The assistant in this tab couldn't load (${needle.status.error}). On an encrypted board the cloud assistant can't read your cards, so change the board directly.`
        : "The assistant in this tab is still loading. On an encrypted board it's the only one that can read your cards.");
      return;
    }
    setText("");
    setLocalBusy(true);
    try {
      const r = await needle.run(board, v);
      if (!r.ok) {
        setLast({ path: "local", note: `not handled: ${r.reason}` });
        setText(v);
        setNotice(`That's more than the assistant in this tab can do on its own (${r.reason}). The cloud assistant can't read an encrypted board, so try one plain step, like "finished the taxes" or "add call mom due Friday", or change the card directly.`);
        return;
      }
      const calls = await Promise.all(r.calls.map((c) => sealCall(vault, c)));
      const stub = (agent as unknown as { stub: { applyLocal(turn: unknown): Promise<unknown> } }).stub;
      await stub.applyLocal({ text: await vault.seal(v), calls, engine: "needle-rs", confidence: r.confidence, ms: r.ms });
      setLast({ path: "local", note: `in this tab · ${r.ms ?? "?"} ms · ${Math.round(r.confidence * 100)}% sure` });
    } catch (e) {
      setText(v);
      setNotice(`That didn't work: ${(e as Error).message}`);
    } finally {
      setLocalBusy(false);
    }
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
            {vault
              ? <p>Your board is encrypted, so the assistant runs only in this tab, and nothing you type here leaves it unencrypted. It handles one plain step at a time: add a card, finish, start, move, set a date, or delete.</p>
              : <p>Tell me what's on your plate, what you finished, or what changed. I'll update the board.</p>}
            <div className="suggestions">
              {(vault ? SEALED_SUGGESTIONS : SUGGESTIONS).map((s) => <button key={s} className="suggestion" onClick={() => send(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {messages.map((m) =>
          m.parts.map((part, i) => {
            const key = `${m.id}-${i}`;
            if (part.type === "text") {
              return part.text.trim() ? <div key={key} className={`msg ${m.role}`}><Plain text={part.text.trim()} vault={vault} /></div> : null;
            }
            if (part.type.startsWith("tool-") && "state" in part) {
              if (part.state === "output-available") {
                const out = (part.output ?? {}) as ToolOutput;
                return (
                  <div key={key} className={`tool-line${out.ok === false ? " fail" : ""}`}>
                    <span className="mark">{out.ok === false ? "✗" : "✓"}</span>
                    <span><Plain text={out.summary ?? "Done"} vault={vault} /></span>
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
        {notice && <div className="msg notice" role="status">{notice}</div>}
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
            <button className="btn primary icon" title="Send" disabled={!text.trim() || (capped && !localReady && !vault)}><IconSend /></button>
          )}
        </form>
        <div className="foot">
          <span className="engine" title={engineTitle(needle.status, model, last)}>
            <span className="prompt">$</span>{" "}
            {vault ? (needle.status.state === "ready" ? "needle-rs in this tab · encrypted, cloud off" : needle.status.state === "loading" ? `loading the local model${needle.status.progress != null ? ` ${Math.round(needle.status.progress * 100)}%` : "…"}` : "encrypted · cloud off")
              : needle.status.state === "ready" ? `needle-rs in this tab · ${model.split("/").pop()} behind it`
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
