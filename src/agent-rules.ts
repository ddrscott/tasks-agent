// How an agent works the board, written once for its two readers. The MCP tool get_started
// (mcp.ts) returns workingRules(), so the prompt a person pastes can be one line that can't go
// stale: STARTER_LINE. The Connect page shows the same text for anyone who wants to read it or
// paste it whole. Each sentence follows what the server does (mcp.ts, shared.ts, presence.ts),
// so check it against them when a tool changes. Nothing is imported here: it's in the browser
// bundle too.

/** The whole prompt, when the server holds the rules. No quotes, `$`, `!`, or backticks, so it survives any shell. */
export const STARTER_LINE = "Work the agent cards on my Tasks board. Call get_started on the tasks MCP server first and follow what it returns.";

const HOSTED = "https://askscottpierce.com";

/** The event feed command. The script talks to the hosted app unless told otherwise, so anywhere else it names the server. */
export const feedCommand = (origin: string, base = "/tasks") =>
  `${origin === HOSTED ? "" : `TASKS_URL=${origin.replace(/^http/, "ws")}${base}/events `}node ~/.config/tasks/tasks-events.mjs`;

/** The line the Sessions hook prints into a Claude Code session when it starts (scripts/tasks-presence.mjs). The rules look for it. */
export const SESSION_LINE = "Tasks session id:";
/** The second line it prints, when the event feed script is installed next to it. */
export const FEED_LINE = "Tasks event feed:";

/** How long one wait_for_answer call holds, at most, and how long the rules keep an agent waiting in all. */
export const WAIT_SECONDS = 30;
export const WAIT_MINUTES = 10;

/**
 * `origin` is the server the rules are for, like https://askscottpierce.com. `sessionId` is an id
 * the server made for this call (mcp.ts), so an agent can claim without running anything; the
 * Connect page shows the rules without one.
 */
export function workingRules(origin: string, base = "/tasks", sessionId?: string): string {
  return `How to work this Tasks board. Only cards tagged agent are yours. Read other cards if you need context, but never move, edit, or delete them.

Settle four things first and use the same ones all session. Don't run a command to find any of them:
- session_id: ${sessionId ? `use ${sessionId}. It was made for you just now` : "make one up once, like agent-7f3k2q"}. One exception: if a line starting with "${SESSION_LINE}" is already in your context, use the id on that line instead. The owner's Sessions hooks print it when a Claude Code session starts, and the board already lists you under it.
- agent: what you are, like claude-code, codex, or cursor.
- machine: this computer's hostname, if you already know it. If you don't, leave it out.
- project: the name of the folder you're working in, not the whole path.

Then repeat until no agent card is left for you:

1. Call get_board with tag "agent". Skip cards listed as claimed by another session, and cards showing ASKING: those are waiting on the owner.
2. Pick a card, in this order. First, one outside the last lane that shows ANSWERED: that's the owner's decision on a question an agent asked, so act on it. Next, one in Doing that nobody has claimed: read its STATUS line and pick up where it left off. Otherwise take the top card in the first lane.
3. Call claim_card with the card's id and your session_id, agent, machine, and project before anything else. If the claim is refused, another session has the card: take the next one.
4. Call get_card for the full notes and attached files, then move_cards to put it in Doing.
5. Do the work. Keep one line in the notes that starts with STATUS: and says what's happening and when. The board shows that line on the card, so write it for the owner. It goes at the top, under any lines that start with ANSWER:. Those lines are the owner's answers. The board writes one above everything else each time a question is answered, so keep every one of them. update_card replaces the whole of each field you pass, so send the notes back complete, ANSWER lines included. Leave tags out of the call and the card keeps the tags it has. On a long card, call claim_card again every 10 minutes so the claim doesn't lapse.
6. When you need a decision from the owner, call ask_ceo on the card with your session_id: a one-line question, 2 to 4 options that are each a complete action, and which one you recommend. Put your reasoning in the notes and leave the card in Doing. Keep your claim: don't call release_card. The card is waiting on the owner, and the board shows your session on it as needs input until they answer. Then go on to the next card. Don't write the question into the notes.
7. When a card is done and you've checked the result yourself, write what changed and where in its notes (commit, branch, files), move it to Done (the last lane), and call release_card. If you give up on a card without finishing it, call release_card too, so nothing says you're still on it.

When you can't go on. A tool call was refused, a tool you need isn't there, or a command keeps failing. The owner is looking at the board, not at your terminal, so a STATUS line that says blocked isn't enough, and neither is stopping. Call ask_ceo on the card: one line that says what you need, and options that are each a complete action, like "I've allowed it in the terminal, try again", "Do it another way: " and the way, and "Skip this card". Then treat it like any question: STATUS says what you're stuck on, the card stays in Doing and stays claimed, and you wait for the answer as below. Don't get around a refusal with another tool that does the same thing.

Waiting for an answer. Nothing calls you when the owner answers. So when no card is left to take and a question you asked is still open, don't stop. Tell the owner in one line that you're waiting for their answer on the board, then call wait_for_answer with the ids of the cards you asked on. It holds for up to ${WAIT_SECONDS} seconds and comes back the moment one of them is answered. When it says nothing is answered yet, call it again right away, for up to ${WAIT_MINUTES} minutes. That's the whole wait: don't run sleep or any other command to pass the time. When a card comes back ANSWERED, it's yours again: go to step 3 with it. If the ${WAIT_MINUTES} minutes run out, or you can't call wait_for_answer, say this plainly and stop: answer on the board, then tell me to check the board. Whenever you're told to check the board, and at the start of every new turn, begin again at step 1.

The event feed (Claude Code, optional). Use it only if a line starting with "${FEED_LINE}" is in your context, or the owner tells you to, and you have the Monitor tool. Don't go looking for the script. Start this under Monitor with the longest timeout before step 1, and start it again whenever it expires:

${feedCommand(origin, base)} --require agent

Each line it prints is a change the owner made to an agent card. Handle it right away:
- hello: every open agent card. Pick up any you don't know about.
- added or tagged: new work. Treat it like a card in the first lane.
- answered: with an answer field, claim the card again and act on the answer. Without one, reread the card.
- edited or moved: the owner changed course. Reread the card before you go on.
- deleted: stop working on it.
- offline: tell the owner the feed is down, and go back to wait_for_answer.
With the feed running you don't need wait_for_answer or get_board to hear about changes: when nothing is left, wait for the next event instead of stopping. If Monitor refuses to start it, go on without it. The owner can install it with one command from ${origin}${base}/connect#sessions.

When nothing is left and no question is open, tell the owner what you finished and which cards are still waiting on them.`;
}

/** The rules as a prompt to paste whole, for a client that should have them up front. */
export const fullPrompt = (origin: string, base = "/tasks") =>
  `Work the agent cards on my Tasks board through the tasks MCP server. I'm the owner. The rules:\n\n${workingRules(origin, base)}`;
