// The assistant on a board someone shared with you (// TEAM_BOARDS in the README). The cloud
// assistant, its transcript, and its daily count are the owner's, so none of that is here:
// this is only the model that runs in the tab (Needle), one plain step at a time. What it
// works out goes to the board as `applyLocal`, which passes the same write guard as a drag or
// an edit, under the writer's own role. The conversation is kept in this tab and nowhere else;
// the server writes nothing a member says into the owner's chat.

import { useEffect, useRef, useState } from "react";
import { IconClose, IconSend } from "./icons";
import { useNeedle } from "./needle";
import type { Board } from "../shared";
import type { ToolOutcome } from "../tools";

type Line = { kind: "user" | "ok" | "fail" | "notice"; text: string };
type Stub = { applyLocal(turn: unknown): Promise<{ outcomes: ToolOutcome[]; reply: string }> };

const SUGGESTIONS = ["Add fix the flaky login test", "Add cut the release Friday"];

type Props = {
  agent: unknown;
  board: Board;
  /** The board's owner, for saying whose the cloud assistant is. */
  owner: string;
  open: boolean;
  onClose(): void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
};

export function MemberChat({ agent, board, owner, open, onClose, inputRef }: Props) {
  const [text, setText] = useState("");
  const [log, setLog] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  // The model loads once the panel has been opened.
  const [wanted, setWanted] = useState(false);
  useEffect(() => { if (open) setWanted(true); }, [open]);
  const needle = useNeedle(wanted);
  const state = needle.status.state;
  const say = (line: Line) => setLog((l) => [...l, line]);

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" }); }, [log, busy]);
  useEffect(() => { if (!text && inputRef.current) inputRef.current.style.height = ""; }, [text, inputRef]);

  async function send(t: string) {
    const v = t.trim();
    if (!v || busy) return;
    if (state !== "ready") {
      say({ kind: "notice", text: needle.status.state === "failed"
        ? `The assistant in this tab couldn't load (${needle.status.error}). The cloud assistant is ${owner}'s, so change the card directly.`
        : state === "off" ? "This browser can't run the assistant in the tab. Change the card directly."
        : "The assistant in this tab is still loading. Try again in a moment." });
      return;
    }
    setText("");
    say({ kind: "user", text: v });
    setBusy(true);
    try {
      const r = await needle.run(board, v);
      if (!r.ok) {
        setText(v);
        say({ kind: "notice", text: `That's more than the assistant in this tab can do on its own (${r.reason}). The cloud assistant is ${owner}'s, so try one plain step, like "add cut the release Friday" or "finished the login test", or change the card directly.` });
        return;
      }
      const res = await (agent as { stub: Stub }).stub.applyLocal({ text: v, calls: r.calls, engine: "needle-rs", confidence: r.confidence, ms: r.ms });
      for (const o of res.outcomes) say({ kind: o.ok ? "ok" : "fail", text: o.summary });
    } catch (e) {
      // The server's refusal, in its own words: view only, or a change that's the owner's to make.
      say({ kind: "fail", text: (e as Error).message || "That didn't work." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className={`chat${open ? "" : " closed"}`} aria-label="Assistant">
      <header className="chat-head">
        <h2 className="h">ASSISTANT</h2>
        <span className="spacer" />
        {log.length > 0 && <button className="btn ghost" onClick={() => setLog([])} disabled={busy}>Clear</button>}
        <button className="btn ghost icon" title="Close" aria-label="Close the assistant" onClick={onClose}><IconClose /></button>
      </header>

      <div className="chat-log" ref={logRef} aria-live="polite">
        {log.length === 0 && (
          <div className="chat-empty">
            <p>
              On a shared board the assistant runs only in this tab. It handles one plain step at a time on cards: add one, finish,
              start, move, set a date, or delete. The cloud assistant belongs to {owner}, the board's owner. Nothing you type here is saved.
            </p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => <button key={s} className="suggestion" onClick={() => void send(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {log.map((l, i) =>
          l.kind === "user" ? <div key={i} className="msg user">{l.text}</div>
          : l.kind === "notice" ? <div key={i} className="msg notice" role="status">{l.text}</div>
          : <div key={i} className={`tool-line${l.kind === "fail" ? " fail" : ""}`}><span className="mark">{l.kind === "fail" ? "✗" : "✓"}</span><span>{l.text}</span></div>,
        )}
        {busy && <div className="working">thinking</div>}
      </div>

      <div className="composer">
        <form className="composer-box" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
          <span className="prompt">$</span>
          <textarea
            ref={inputRef} rows={1} value={text} placeholder="One step, like: add a card…" aria-label="Message the assistant"
            onChange={(e) => { setText(e.target.value); e.target.style.height = "auto"; e.target.style.height = `${e.target.scrollHeight}px`; }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(text); }
              if (e.key === "Escape") e.currentTarget.blur();
            }}
          />
          <button className="btn primary icon" title="Send" aria-label="Send" disabled={!text.trim() || busy}><IconSend /></button>
        </form>
        <div className="foot">
          <span className="engine">
            <span className="prompt">$</span>{" "}
            {state === "ready" ? "runs in your browser · cloud assistant is the owner's"
              : state === "loading" ? `loading the browser model${needle.status.state === "loading" && needle.status.progress != null ? ` ${Math.round(needle.status.progress * 100)}%` : "…"}`
              : state === "failed" ? "the browser model didn't load"
              : "runs in your browser"}
          </span>
        </div>
      </div>
    </aside>
  );
}
