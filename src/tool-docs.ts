// Every tool the MCP server offers, described once for its two readers. `description` is what
// an agent reads when it lists the tools; `about` is the line a person reads on the Connect
// page. They sit side by side so changing what a tool does means changing both.
//
// The server (mcp.ts, tools.ts) takes its descriptions from here and the Connect page lists
// these entries in this order, so the page can't name a tool the server doesn't have or miss
// one it does. Nothing is imported here, which keeps the schemas out of the browser bundle.

type ToolDoc = {
  description: string;
  about: string;
  /** Flagged on the Connect page, and for clients that ask before running a destructive tool. */
  destructive?: boolean;
};

export const TOOL_DOCS = {
  get_started: {
    description:
      "Read the rules for working this board on your own: which cards are yours, how to claim one, the STATUS line, asking the owner, " +
      "coming back for the answer, and finishing. Call it once, before your first card, whenever you're asked to work the board.",
    about: "Read the working rules: which cards are its own, claiming, the status line, asking you, and finishing. The starter prompt has the agent call this first.",
  },
  get_board: {
    description: "Show every lane and card on the board, with ids, due dates, tags, the start of each card's notes, and the names of its files. Pass tag to list only the cards carrying it. Call get_card for a card's full notes and attachments.",
    about: "Read every lane and card: ids, due dates, tags, and the start of each card's notes. Can list just the cards with one tag.",
  },
  get_card: {
    description:
      "Show one card in full: the whole of its notes (get_board cuts them short), lane, tags, due date, any question " +
      "asked of the owner and their answer, and its attachments. Attached images come back as images you can look at, " +
      "and small text files as text. Call this before you act on a card whose notes or files you haven't read in full.",
    about: "Read one card in full: all of its notes, its question and your answer, and its files. Attached images come back as images the agent can look at.",
  },
  search_cards: {
    description:
      "Search cards by keywords and by meaning across titles and notes. Returns matching cards with ids, " +
      "lanes, due dates, and a snippet. Use it to find the card a user means when the board is large or the wording differs.",
    about: "Find cards by keyword or by meaning across titles and notes.",
  },
  add_cards: {
    description: "Create one or more cards. Use this for every new task the user mentions.",
    about: "Create one or more cards in any lane, with notes, due dates, and tags.",
  },
  move_cards: {
    description: "Move cards to a lane, for example to Done when the user finished something.",
    about: "Move cards between lanes, for example to Done.",
  },
  update_card: {
    description: "Change a card's title, notes, due date, or tags. A field you leave out stays as it is. notes replaces all of the notes, so send back what you're keeping, including any ANSWER: lines. Pass due: null to clear a due date. tags replaces the whole list, so include the ones to keep; [] removes them all.",
    about: "Change a card's title, notes, due date, or tags.",
  },
  delete_cards: {
    description: "Permanently delete cards. Prefer moving to Done unless the user asked to delete or remove.",
    about: "Delete cards.",
    destructive: true,
  },
  add_lane: {
    description: "Add a new lane (column) to the right of the others.",
    about: "Add a lane.",
  },
  rename_lane: {
    description: "Rename a lane.",
    about: "Rename a lane.",
  },
  delete_lane: {
    description: "Delete a lane AND every card in it. Only when the user explicitly asks.",
    about: "Delete a lane and every card in it.",
    destructive: true,
  },
  ask_ceo: {
    description:
      "Ask the board's owner to decide something, as a multiple-choice question on a card. The card gets #needs-ceo and " +
      "shows one button per option in the app; the owner answers with a tap. Use this instead of writing a question into " +
      "the notes, and when you can't go on with a card: say what you need. The answer shows in get_board as ANSWERED. Keep the question to " +
      "one line, make the options complete actions, and put the reasoning in the card's notes. Move on to other work, and call wait_for_answer when none is left.",
    about: "Ask you a multiple-choice question on a card. You answer with one tap.",
  },
  wait_for_answer: {
    description:
      "Wait for the owner to answer questions you asked with ask_ceo. Pass the ids of the cards you asked on. It holds for up to 30 seconds " +
      "(seconds changes that) and returns as soon as one is answered, with that card in full. If nothing is answered in that time it says so: " +
      "call it again to keep waiting. Use this instead of sleeping or calling get_board over and over.",
    about: "Wait for your answer. It holds for up to 30 seconds and returns the moment you answer one of the agent's questions.",
  },
  claim_card: {
    description:
      "Claim a card for your session before you work on it, so two agents never take the same one. " +
      "Pass agent, machine, and project too: the board shows them on the card, and says unknown without them. " +
      "Refused while another live session holds the card; that answer names the holder. " +
      "A claim lapses 15 minutes after its session was last heard from, and calling this again renews yours.",
    about: "Claim a card for one agent session, so two agents never take the same one.",
  },
  release_card: {
    description: "Give up your claim on a card, when you finish it or stop working on it. Only the session holding the claim can release it.",
    about: "Give a claimed card back.",
  },
} satisfies Record<string, ToolDoc>;

export type McpToolName = keyof typeof TOOL_DOCS;

/** For the Connect page: every tool, in the order above. */
export const TOOL_LIST: { name: McpToolName; about: string; destructive: boolean }[] =
  (Object.keys(TOOL_DOCS) as McpToolName[]).map((name) => {
    const d: ToolDoc = TOOL_DOCS[name];
    return { name, about: d.about, destructive: !!d.destructive };
  });
