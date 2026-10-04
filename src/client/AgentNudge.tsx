import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { agentConnected, needsAgent, waitsForAgent, type Board, type Card } from "../shared";
import { BASE } from "./base";
import { IconClose } from "./icons";

// What the board says while no agent has ever connected to it. `// START_HERE` (FirstRun.tsx)
// covers the empty board and goes away with the first card; from then on this is the only thing
// that says nothing will pick up an #agent card. There's a quiet line above the lanes, a chip on
// each card that's waiting for an agent, and a line in that card's editor, each with a link to
// the Connect page. All of it goes away, in every open tab, the moment an agent makes its first
// MCP call (`agentSeenAt` on the board), and it never shows on an encrypted board.

type Ctx = { board: Board; onConnect(): void };
/** Set only while the board has cards and no agent has ever connected. */
const NoAgentContext = createContext<Ctx | null>(null);

export function NoAgentProvider({ board, onConnect, children }: { board: Board; onConnect(): void; children: ReactNode }) {
  const needs = needsAgent(board);
  const value = useMemo(() => (needs ? { board, onConnect } : null), [needs, board, onConnect]);
  return <NoAgentContext.Provider value={value}>{children}</NoAgentContext.Provider>;
}

/** A real link to the Connect page, so it opens in a new tab too; a plain click stays in the app. */
function ConnectLink({ onConnect, className, title, children, quiet }: { onConnect(): void; className?: string; title?: string; children: ReactNode; quiet?: boolean }) {
  // On a card, a press on the link mustn't start a drag or open the editor underneath.
  const stop = quiet ? (e: { stopPropagation(): void }) => e.stopPropagation() : undefined;
  return (
    <a
      className={className} title={title} href={`${BASE}/connect`} tabIndex={quiet ? -1 : undefined}
      onPointerDown={stop} onMouseDown={stop} onTouchStart={stop} onKeyDown={stop}
      onClick={(e) => {
        e.stopPropagation();
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        onConnect();
      }}
    >{children}</a>
  );
}

const DISMISSED = "tasks-no-agent-hidden";
const hidden = () => { try { return sessionStorage.getItem(DISMISSED) === "1"; } catch { return false; } };

/**
 * The line above the lanes. The X hides it for this browser session only: it's back on the next
 * visit, until an agent connects. `say` is the board's toast, used once when that happens.
 */
export function AgentNudge({ board, say }: { board: Board; say(text: string): void }) {
  const ctx = useContext(NoAgentContext);
  const [off, setOff] = useState(hidden);

  // The moment this was waiting for: say so, since the line just disappears otherwise.
  const connected = !board.sealed && agentConnected(board);
  const was = useRef(connected);
  useEffect(() => {
    if (connected && !was.current) say("An agent just connected. It can pick up your #agent cards now.");
    was.current = connected;
  }, [connected]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ctx || off) return null;
  const waiting = board.cards.filter((c) => waitsForAgent(board, c)).length;
  return (
    <aside className="agent-nudge" aria-label="No agent connected">
      <span className="agent-nudge-mark" aria-hidden="true">//</span>
      <span className="agent-nudge-text">
        <b>No agent connected yet.</b>{" "}
        {waiting ? `Nothing will pick up your ${waiting === 1 ? "#agent card" : `${waiting} #agent cards`}.` : "Until one is, nothing works the cards you tag #agent."}{" "}
        <ConnectLink onConnect={ctx.onConnect}>Connect an agent</ConnectLink>
      </span>
      <button
        type="button" className="btn ghost icon agent-nudge-x" title="Hide for now. It comes back until an agent connects." aria-label="Hide for now"
        onClick={() => { try { sessionStorage.setItem(DISMISSED, "1"); } catch { /* private window */ } setOff(true); }}
      ><IconClose /></button>
    </aside>
  );
}

/** On the card face, beside its tags: this card is tagged for an agent and there isn't one. */
export function NoAgentChip({ card }: { card: Card }) {
  const ctx = useContext(NoAgentContext);
  if (!ctx || !waitsForAgent(ctx.board, card)) return null;
  return (
    <ConnectLink quiet className="chip no-agent" onConnect={ctx.onConnect} title="No agent is connected, so nothing will pick this card up. Connect one.">
      no agent connected
    </ConnectLink>
  );
}

/** The same thing in the card editor, spelled out. `before` runs first (the editor saves and closes). */
export function NoAgentLine({ card, before }: { card: Card; before?(): void }) {
  const ctx = useContext(NoAgentContext);
  if (!ctx || !waitsForAgent(ctx.board, card)) return null;
  return (
    <p className="no-agent-line">
      No agent is connected, so nothing will pick this card up.{" "}
      <ConnectLink onConnect={() => { before?.(); ctx.onConnect(); }}>Connect an agent</ConnectLink>
    </p>
  );
}
