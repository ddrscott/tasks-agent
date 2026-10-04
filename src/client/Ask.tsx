// Questions an agent put on a card (the ask_ceo MCP tool), answered with one tap: a button per
// option on the card itself, the same in the card editor with a box for anything else, and a
// count in the top bar that opens them all so they can be cleared in a row.

import { createContext, useContext, useState } from "react";
import type { Card } from "../shared";
import { Popover } from "./Board";

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
  if (!ask) return null;
  const send = (input: { choice?: number; text?: string }) => { before?.(); answer(card.id, input); };
  return (
    <div className={`ask${compact ? " compact" : ""}`} onClick={(e) => e.stopPropagation()}>
      <div className="ask-q"><span className="ask-mark" aria-hidden="true">?</span>{ask.question}</div>
      <div className="ask-options">
        {ask.options.map((o, i) => (
          <button
            key={i} type="button" tabIndex={compact ? -1 : 0} {...quiet}
            className={`ask-opt${ask.recommended === i ? " rec" : ""}`}
            title={ask.recommended === i ? "The agent recommends this one" : undefined}
            onClick={(e) => { e.stopPropagation(); send({ choice: i }); }}
          >
            <span className="ask-n">{i + 1}</span>
            <span className="ask-text">{o}</span>
            {ask.recommended === i && <span className="ask-rec">recommended</span>}
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

type ButtonProps = { cards: Card[]; open: boolean; setOpen(o: boolean): void; onOpenCard(id: string): void };

/** "2 need you" in the top bar. It's only there while a question is open. */
export function AsksButton({ cards, open, setOpen, onOpenCard }: ButtonProps) {
  const asking = cards.filter((c) => c.ask).sort((a, b) => a.ask!.askedAt.localeCompare(b.ask!.askedAt));
  if (!asking.length) return null;
  return (
    <div className="anchor">
      <button
        className="btn asks-btn" aria-expanded={open} onClick={() => setOpen(!open)}
        title="Questions waiting on you" aria-label={`${asking.length} question${asking.length === 1 ? "" : "s"} waiting on you`}
      >
        <span className="asks-count">?{asking.length}</span>
        <span className="hide-sm label">need{asking.length === 1 ? "s" : ""} you</span>
      </button>
      {open && (
        <Popover onClose={() => setOpen(false)}>
          <div className="asks">
            <h2 className="h">NEEDS_YOU</h2>
            {asking.map((c) => (
              <section key={c.id}>
                <button className="asks-card" onClick={() => { setOpen(false); onOpenCard(c.id); }} title="Open the card">{c.title}</button>
                <AskBlock card={c} />
              </section>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}
