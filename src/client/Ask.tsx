// Questions an agent put on a card (the ask_ceo MCP tool), answered with one tap: a button per
// option on the card itself, the same in the card editor with a box for anything else, and a
// count in the top bar that opens them all so they can be cleared in a row. On a touch screen
// the buttons on the card itself take two taps, because the board is where stray taps land.
// That count is everything waiting on you: it also takes in the sessions stopped at a prompt.

import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { Card } from "../shared";
import { Popover } from "./Board";
import { blockedSessions, SessionRow, type Presence } from "./Sessions";

export type AnswerFn = (cardId: string, input: { choice?: number; text?: string }) => void;

/** How a card answers its question. Provided by App, so the buttons work wherever a card is drawn. */
export const AskContext = createContext<AnswerFn>(() => {});

// A card is draggable and opens on click, so its buttons keep those to themselves.
const quiet = {
  onPointerDown: (e: React.SyntheticEvent) => e.stopPropagation(),
  onMouseDown: (e: React.SyntheticEvent) => e.stopPropagation(),
  onTouchStart: (e: React.SyntheticEvent) => e.stopPropagation(),
  onKeyDown: (e: React.SyntheticEvent) => e.stopPropagation(),
};

/** The same test the stylesheet uses for touch screens. */
const TOUCH = "(hover: none) and (pointer: coarse)";
/** How long a first tap on a card-face answer waits for its second. */
const ARMED_MS = 5000;

type BlockProps = {
  card: Card;
  /** On a card face: options only. Elsewhere there's also a box for a typed answer. */
  compact?: boolean;
  /** Runs before the answer is sent, for the card editor to save and close first. */
  before?(): void;
};

export function AskBlock({ card, compact, before }: BlockProps) {
  const answer = useContext(AskContext);
  const [other, setOther] = useState("");
  const ask = card.ask;
  const send = (input: { choice?: number; text?: string }) => { before?.(); answer(card.id, input); };

  // On a card face on a touch screen, the first tap on an option only arms it ("Send: …?") and
  // a second tap on the same one sends. An answer goes to the agent the moment it's sent, and
  // Undo can't take that back. A tap anywhere else, or five seconds, disarms it.
  const [armed, setArmed] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (armed === null) return;
    const timer = setTimeout(() => setArmed(null), ARMED_MS);
    // Taps on this question's own options are left to pick(): the same one sends, another one arms instead.
    const away = (e: PointerEvent) => {
      const opt = e.target instanceof Element ? e.target.closest(".ask-opt") : null;
      if (!opt || !root.current?.contains(opt)) setArmed(null);
    };
    // Capture phase, because cards stop pointer events from bubbling to keep taps from starting a drag.
    document.addEventListener("pointerdown", away, true);
    return () => { clearTimeout(timer); document.removeEventListener("pointerdown", away, true); };
  }, [armed]);

  if (!ask) return null;
  function pick(i: number) {
    if (compact && armed !== i && matchMedia(TOUCH).matches) { setArmed(i); return; }
    setArmed(null);
    send({ choice: i });
  }
  return (
    <div ref={root} className={`ask${compact ? " compact" : ""}`} onClick={(e) => e.stopPropagation()}>
      <div className="ask-q"><span className="ask-mark" aria-hidden="true">?</span>{ask.question}</div>
      <div className="ask-options">
        {ask.options.map((o, i) => (
          <button
            key={i} type="button" tabIndex={compact ? -1 : 0} {...quiet}
            className={`ask-opt${ask.recommended === i ? " rec" : ""}${armed === i ? " armed" : ""}`}
            title={ask.recommended === i ? "The agent recommends this one" : undefined}
            onClick={(e) => { e.stopPropagation(); pick(i); }}
          >
            <span className="ask-n">{i + 1}</span>
            <span className="ask-text">{armed === i ? `Send: ${o}?` : o}</span>
            {/* The outline alone reads as "selected", so the pick is always named; a card face has room for three letters. */}
            {ask.recommended === i && <span className="ask-rec">{compact ? "rec" : "recommended"}</span>}
          </button>
        ))}
      </div>
      {!compact && (
        <form
          className="ask-other"
          onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); if (other.trim()) send({ text: other }); }}
        >
          <input
            className="field" value={other} maxLength={500} placeholder="Or type another answer…" aria-label="Another answer"
            onChange={(e) => setOther(e.target.value)} onKeyDown={(e) => e.stopPropagation()}
          />
          <button type="submit" className="btn" disabled={!other.trim()}>Answer</button>
        </form>
      )}
    </div>
  );
}

type ButtonProps = { cards: Card[]; presence: Presence; open: boolean; setOpen(o: boolean): void; onOpenCard(id: string): void };

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * "3 need you" in the top bar: the one count of what's waiting on you, and the one list. Open
 * questions come first because they're answered right here; then the sessions stopped at a prompt,
 * which have to be answered in their own terminal. It's only there while something is waiting.
 */
export function AsksButton({ cards, presence, open, setOpen, onOpenCard }: ButtonProps) {
  const asking = cards.filter((c) => c.ask).sort((a, b) => a.ask!.askedAt.localeCompare(b.ask!.askedAt));
  const blocked = blockedSessions(presence.sessions, presence.now);
  const total = asking.length + blocked.length;
  if (!total) return null;
  const summary = [asking.length && count(asking.length, "question"), blocked.length && count(blocked.length, "blocked session")].filter(Boolean).join(", ");
  return (
    <div className="anchor">
      <button
        className="btn asks-btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}
        // The label can be down to a bare count when the bar is tight, so the name is spelled out.
        title={`Waiting on you: ${summary}`} aria-label={`${total} waiting on you: ${summary}`}
      >
        <span className="asks-count">?{total}</span>
        <span className="hide-sm label">need{total === 1 ? "s" : ""} you</span>
      </button>
      {open && (
        <Popover label="Waiting on you" onClose={() => setOpen(false)}>
          <div className="asks">
            <h2 className="h">NEEDS_YOU</h2>
            {asking.map((c) => (
              <section key={c.id}>
                <button className="asks-card" onClick={() => { setOpen(false); onOpenCard(c.id); }} title="Open the card">{c.title}</button>
                <AskBlock card={c} />
              </section>
            ))}
            {blocked.map((s) => (
              <section key={s.id}>
                <h3 className="asks-project">{s.project}</h3>
                <ul className="card-session">
                  <SessionRow
                    session={s} now={presence.now}
                    cards={presence.claims.filter((c) => c.sessionId === s.id).map((c) => cards.find((k) => k.id === c.cardId)?.title).filter((t): t is string => !!t)}
                  />
                </ul>
              </section>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}
