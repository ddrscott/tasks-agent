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
 * The sample card. It's safe anywhere, and it can finish on what the copied command allows: the
 * board's tools, plus reading the folder, which Claude Code doesn't ask about. The agent reads,
 * asks which improvement to plan, and writes the plan on the card. No file is written and
 * nothing runs but a listing, so nothing waits on an approval in a terminal the visitor isn't
 * looking at. (Claude Code 2.1 has no Glob tool; it lists with a read-only ls, which it runs
 * without asking. Telling the agent "no shell at all" left it guessing at file names.)
 */
export const SAMPLE = {
  title: "Look around this folder and plan one small improvement",
  notes: `A sample card, to show how an agent works this board. Delete it whenever you like.

Look at the folder you were started in, by reading only. List the files with whatever needs no approval from me, a file tool or a plain ls, then read the README and anything else short that says what this is. Don't write or edit a file, and don't run a command that changes anything. Nothing on this card needs either, so there's nothing for me to approve in the terminal.

Find 2 or 3 small improvements that would each take a few minutes, like a gap in the README, a missing .gitignore entry, or a typo. If the folder is empty or isn't code, offer first steps instead, like what a README for it should say.

Ask me which one with ask_ceo: one option for each, and a last option, "None of these". Recommend the one you'd pick.

When I answer, write a short plan for that one in these notes: 3 to 6 lines that each start with "- [ ]", naming the files to touch. Don't make the change itself. If I say none, write one line saying so. Then move the card to Done.`,
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
          : "Your sample card is on the board. Two steps left: copy the command and paste it in a terminal."}
      />
      <p className="first-run-foot">
        For your own work, add <code>#agent</code> to the end of a card's title, or use its Tags field.
        {board.cards.length === 0 ? " This goes away once the board has a card of yours." : " This goes away when an agent connects, or when you delete the sample card."}
      </p>
    </section>
  );
}
