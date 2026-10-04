import { useEffect, useRef } from "react";
import { agentConnected, AGENT_TAG, hasTag, type Board } from "../shared";
import { QuickStart, SAMPLE_INTENT } from "./Connect";
import type { NewCardInput } from "./NewCard";

// What a board shows above its lanes until its first agent connects: `// START_HERE`, the four
// steps that end with Claude Code working a card (QuickStart in Connect.tsx). An empty kanban
// says nothing about agents, which are the reason to use this one.
//
// It shows on a board with no cards, and stays while the sample card it adds is the thing being
// set up, so step 3 is still there after step 2. It's gone the moment an agent connects, or when
// the board has cards and the sample isn't one of them ("No agent connected yet" in
// AgentNudge.tsx takes over there). An encrypted board never shows it: agents can't reach one.

/**
 * The sample card. It's safe anywhere: the agent looks, proposes, and asks before it changes a
 * file, which is also what shows off the loop. The question lands on the card and one tap answers it.
 */
export const SAMPLE = {
  title: "Look around this folder and suggest one small improvement",
  notes: `A sample card, to show how an agent works this board. Delete it whenever you like.

Look at the folder you were started in: the README, the scripts, whatever is there. Find 2 or 3 small improvements you could make in a few minutes, like a gap in the README, a missing .gitignore entry, or a typo. If the folder is empty or there's nothing worth fixing, offer to write a short README instead.

Don't change any files yet. Ask me which one to do with ask_ceo: one option for each improvement, and a last option, "Leave it all alone". Recommend the one you'd pick.

When I answer, do only that one. If I say to leave it alone, change nothing. Then write what you did in these notes and move the card to Done.`,
  tags: [AGENT_TAG],
};

const openSample = (b: Board) => {
  const done = b.lanes.length > 1 ? b.lanes[b.lanes.length - 1]?.id : undefined;
  return b.cards.some((c) => c.title === SAMPLE.title && hasTag(c, AGENT_TAG) && c.laneId !== done);
};

/** Whether `// START_HERE` is showing. AgentNudge.tsx stays quiet while it is, so the board says it once. */
export const quickStartOpen = (b: Board) => !b.sealed && !agentConnected(b) && (b.cards.length === 0 || openSample(b));

export function FirstRun({ board, onConnect, add, say }: {
  board: Board;
  onConnect(): void;
  /** The New card dialog's add: one change, so one Undo takes the card back out. */
  add(input: NewCardInput): Promise<unknown>;
  say(text: string, undo?: boolean): void;
}) {
  const hasSample = openSample(board);
  const lane = board.lanes[0];

  function addSample() {
    if (!lane || hasSample) return;
    add({ laneId: lane.id, title: SAMPLE.title, notes: SAMPLE.notes, due: null, tags: SAMPLE.tags })
      .then(() => say(`Added a sample agent card to ${lane.name}`, true))
      .catch((e: Error) => say(e.message));
  }

  // The Connect page's "Add a sample agent card" lands here: it can't reach the board itself.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || board.sealed) return;
    asked.current = true;
    try {
      if (sessionStorage.getItem(SAMPLE_INTENT) !== "1") return;
      sessionStorage.removeItem(SAMPLE_INTENT);
    } catch { return; }
    addSample();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!quickStartOpen(board)) return null;
  return (
    <section className="first-run" aria-labelledby="first-run-h">
      <h2 className="h" id="first-run-h">START_HERE</h2>
      <QuickStart
        signedIn hasSample={hasSample} onAddSample={addSample} onConnect={onConnect}
        lede={board.cards.length === 0
          ? "This board is empty. Four steps put Claude Code to work on it."
          : "Two steps left, and Claude Code is working your sample card."}
      />
      <p className="first-run-foot">
        For your own work, add <code>#agent</code> to the end of a card's title, or use its Tags field.
        {board.cards.length === 0 ? " This goes away once the board has a card of yours." : " This goes away when an agent connects, or when you delete the sample card."}
      </p>
    </section>
  );
}
