// Simulated boards and hand-labeled chat commands for the routing bench.
// There's no real traffic to mine yet, so these stand in for it. The traps are
// deliberate: near-duplicate cards (two dentist cards), references that only the
// notes explain ("the boots"), reopens, moves to two different lanes in one
// message, and messages with no clear card at all.

import type { Board, Card } from "../src/shared";

/** What the right answer does to the board. `ask` means a good assistant asks instead of acting. */
export type Op = "move" | "create" | "edit" | "delete" | "none" | "mixed" | "ask";
export type Gold = { op: Op; cards?: string[]; lane?: string; laneAlt?: string[] };
export type Case = { id: string; board: string; msg: string; gold: Gold };

/** Wednesday. Every relative date in the cases resolves against it. */
export const TODAY = "Wednesday, 2026-09-23";

/**
 * What each lane means, in a line. Boards only store lane names, so these stand in for
 * a lane-description field: Jev scores a category far better when it's told what the
 * category means than when it only has the name.
 */
export const LANE_NOTES: Record<string, Record<string, string>> = {
  home: {
    todo: "Open task or not started or return to beginning.",
    doing: "Started and in progress right now.",
    done: "Finished. Nothing left to do.",
  },
  dev: {
    backlog: "Open task or not started or return to beginning.",
    wip: "Being written or built right now.",
    review: "The author is done and it's waiting on someone else: code review, PR open, up for review, ready for QA.",
    shipped: "Merged, deployed, or released. Only use it when the message says it shipped, merged, went out, or is live.",
  },
  big: {
    inbox: "Open task or not started or return to beginning. Captured but not planned.",
    week: "Planned for this week but not started.",
    doing: "Started and in progress right now.",
    done: "Finished. Nothing left to do.",
  },
};

const T = "2026-09-01T12:00:00.000Z";
function board(lanes: [string, string][], cards: [string, string, string, string?, string?][]): Board {
  return {
    lanes: lanes.map(([id, name]) => ({ id, name })),
    cards: cards.map(([id, laneId, title, due, notes]): Card => ({
      id, laneId, title, due: due ?? null, notes: notes ?? "", createdAt: T, updatedAt: T,
    })),
    theme: "auto",
  };
}

export const BOARDS: Record<string, Board> = {
  home: board([["todo", "To do"], ["doing", "Doing"], ["done", "Done"]], [
    ["h01", "todo", "Book dentist cleaning"],
    ["h02", "todo", "File quarterly taxes", "2026-09-30"],
    ["h03", "todo", "Renew car registration", "2026-10-05"],
    ["h04", "todo", "Call Mom about Thanksgiving"],
    ["h05", "todo", "Replace furnace filter"],
    ["h06", "todo", "Pay dentist bill", undefined, "$180 from the August visit"],
    ["h07", "todo", "Return Amazon package", undefined, "Wrong size hiking boots"],
    ["h08", "doing", "Plan Sarah's birthday party", undefined, "Oct 12, still need a venue"],
    ["h09", "doing", "Research new health insurance plans"],
    ["h10", "done", "Oil change"],
    ["h11", "done", "Cancel gym membership"],
    ["h12", "done", "Order new glasses"],
  ]),
  dev: board([["backlog", "Backlog"], ["wip", "In progress"], ["review", "Review"], ["shipped", "Shipped"]], [
    ["b01", "backlog", "Fix login redirect loop on Safari"],
    ["b02", "backlog", "Add dark mode to settings page"],
    ["b03", "backlog", "Write migration for subscriptions table"],
    ["b04", "backlog", "Upgrade wrangler to v4"],
    ["b05", "backlog", "Flaky test in search.spec"],
    ["b06", "backlog", "Rate limit the MCP endpoint"],
    ["b07", "wip", "Stripe webhook retries"],
    ["b08", "wip", "Refactor auth middleware"],
    ["b09", "review", "Attachment upload progress bar"],
    ["b10", "review", "Docs for MCP setup"],
    ["b11", "shipped", "Google sign-in"],
    ["b12", "shipped", "Turnstile on login"],
  ]),
  big: board([["inbox", "Inbox"], ["week", "This week"], ["doing", "Doing"], ["done", "Done"]], [
    ["k01", "inbox", "Fix garage door"],
    ["k02", "inbox", "Research standing desks"],
    ["k03", "inbox", "Podcast episode outline"],
    ["k04", "inbox", "Cancel unused streaming subscriptions"],
    ["k05", "inbox", "Conference talk proposal", undefined, "CFP closes Oct 1"],
    ["k06", "inbox", "Clean out the shed"],
    ["k07", "inbox", "Learn basic Spanish"],
    ["k08", "inbox", "Donate old clothes"],
    ["k09", "week", "Send September invoice to Acme Corp", "2026-09-25"],
    ["k10", "week", "Book flights to Denver", undefined, "Oct 18-21, cousin's wedding"],
    ["k11", "week", "Vet appointment for Biscuit", "2026-09-24"],
    ["k12", "week", "Expense report for August"],
    ["k13", "week", "Lunch with Priya", "2026-09-24"],
    ["k14", "week", "Review Dana's pitch deck"],
    ["k15", "week", "Newsletter draft", "2026-09-24"],
    ["k16", "week", "Renew passport", undefined, "Expires in January"],
    ["k17", "week", "Pick up prescription"],
    ["k18", "week", "Car wash"],
    ["k19", "week", "Q3 quarterly report"],
    ["k20", "doing", "Rewrite onboarding emails"],
    ["k21", "doing", "Replace kitchen faucet"],
    ["k22", "doing", "Hire contractor for the deck"],
    ["k23", "done", "Update household budget spreadsheet"],
    ["k24", "done", "Schedule annual physical"],
    ["k25", "done", "Submit timesheet"],
    ["k26", "done", "Water the plants"],
    ["k27", "done", "Order printer ink"],
    ["k28", "done", "Back up laptop"],
    ["k29", "done", "Pay credit card"],
    ["k30", "done", "Call bank about fraud alert"],
  ]),
};

const mv = (cards: string[], lane: string, laneAlt?: string[]): Gold => ({ op: "move", cards, lane, laneAlt });
const g = (op: Op, cards?: string[]): Gold => ({ op, cards });

const RAW: [string, string, Gold][] = [
  // home
  ["home", "finished the dentist thing", g("ask")], // booking or the bill?
  ["home", "booked the dentist cleaning", mv(["h01"], "done")],
  ["home", "paid the dentist", mv(["h06"], "done")],
  ["home", "taxes are filed!!", mv(["h02"], "done")],
  ["home", "started on the furnace filter", mv(["h05"], "doing")],
  ["home", "working on the car registration now", mv(["h03"], "doing")],
  ["home", "called mom", mv(["h04"], "done")],
  ["home", "dropped off the amazon return", mv(["h07"], "done")],
  ["home", "the boots went back", mv(["h07"], "done")],
  ["home", "actually the oil change isn't done, they need me to come back", mv(["h10"], "todo", ["doing"])],
  ["home", "done with sarah's party planning and the insurance research", mv(["h08", "h09"], "done")],
  ["home", "finished taxes and registration", mv(["h02", "h03"], "done")],
  ["home", "gym cancel didn't go through, reopen it", mv(["h11"], "todo", ["doing"])],
  ["home", "put the glasses back in doing", mv(["h12"], "doing")],
  ["home", "add pick up dry cleaning", g("create")],
  ["home", "remind me to buy a birthday gift for Sarah by Oct 10", g("create")],
  ["home", "change the taxes due date to Oct 15", g("edit", ["h02"])],
  ["home", "rename call mom to call mom and dad", g("edit", ["h04"])],
  ["home", "delete the furnace filter card", g("delete", ["h05"])],
  ["home", "what's due this week?", g("none")],
  ["home", "thanks!", g("none")],
  ["home", "paid the dentist bill, and add schedule a follow-up visit", g("mixed")],
  ["home", "how many things are left to do?", g("none")],
  ["home", "move everything in doing to done", mv(["h08", "h09"], "done")],
  ["home", "I finished it", g("ask")],
  ["home", "renew registration done. car stuff sorted", mv(["h03"], "done")],
  // dev: custom lanes, so "done" has to mean Shipped
  ["dev", "safari login loop is fixed and shipped", mv(["b01"], "shipped")],
  ["dev", "picking up the dark mode ticket", mv(["b02"], "wip")],
  ["dev", "webhook retries are ready for review", mv(["b07"], "review")],
  ["dev", "the progress bar PR got merged", mv(["b09"], "shipped")],
  ["dev", "MCP docs merged", mv(["b10"], "shipped")],
  ["dev", "reviewer bounced the attachment progress bar, back to in progress", mv(["b09"], "wip")],
  ["dev", "start on the wrangler upgrade and the flaky search test", mv(["b04", "b05"], "wip")],
  ["dev", "auth refactor is up for review", mv(["b08"], "review")],
  ["dev", "add a card to backlog: CSV export", g("create")],
  ["dev", "file a bug: search results flicker on mobile", g("create")],
  ["dev", "add a note to the stripe webhook card that retries need idempotency keys", g("edit", ["b07"])],
  ["dev", "kill the rate limit ticket, we're not doing it", g("delete", ["b06"])],
  ["dev", "what's in review?", g("none")],
  ["dev", "is google sign-in shipped?", g("none")],
  ["dev", "migration for subscriptions is done", mv(["b03"], "shipped")],
  ["dev", "merged the auth refactor and started on rate limiting", g("mixed")], // two lanes
  ["dev", "turnstile got reverted, reopen it", mv(["b12"], "backlog", ["wip"])],
  ["dev", "stripe webhooks: shipped", mv(["b07"], "shipped")],
  // big: 30 cards, four lanes
  ["big", "sent the invoice to Acme", mv(["k09"], "done")],
  ["big", "started the quarterly report", mv(["k19"], "doing")],
  ["big", "booked flights for Denver", mv(["k10"], "done")],
  ["big", "vet appointment for Biscuit went fine", mv(["k11"], "done")],
  ["big", "moving the podcast outline to this week", mv(["k03"], "week")],
  ["big", "pull the conference talk proposal into doing", mv(["k05"], "doing")],
  ["big", "done: expense report, lunch with Priya", mv(["k12", "k13"], "done")],
  ["big", "add call plumber about the leak", g("create")],
  ["big", "push the newsletter draft to friday", g("edit", ["k15"])],
  ["big", "what's overdue?", g("none")],
  ["big", "finished the thing for Dana", mv(["k14"], "done")],
  ["big", "renewed the passport", mv(["k16"], "done")],
  ["big", "priya lunch is off, delete it", g("delete", ["k13"])],
  ["big", "ugh, back to square one on the budget spreadsheet", mv(["k23"], "inbox", ["week", "doing"])],
  ["big", "got the car washed and picked up the prescription", mv(["k17", "k18"], "done")],
  ["big", "move fix garage door to this week and add a card to buy a new opener", g("mixed")],
  // Holdout (q61–q80), written 2026-09-25 after the Jev question wording was tuned on
  // q01–q60. Plain everyday phrasing. Don't tune prompts or lane notes against these.
  ["home", "just sent the amazon package back", mv(["h07"], "done")],
  ["home", "I mailed the tax forms", mv(["h02"], "done")],
  ["home", "not ready for sarah's party yet, put it back in to do", mv(["h08"], "todo")],
  ["home", "furnace filter is replaced", mv(["h05"], "done")],
  ["home", "can you add get a flu shot", g("create")],
  ["home", "talked to mom", mv(["h04"], "done")],
  ["home", "the car registration is due the 12th now", g("edit", ["h03"])],
  ["dev", "opened a PR for the stripe webhook retries", mv(["b07"], "review")],
  ["dev", "dark mode is live", mv(["b02"], "shipped")],
  ["dev", "I'm working on the flaky search test", mv(["b05"], "wip")],
  ["dev", "the MCP docs need more work, pulling them back", mv(["b10"], "wip", ["backlog"])],
  ["dev", "we don't need the wrangler upgrade anymore, remove it", g("delete", ["b04"])],
  ["dev", "what am I working on right now?", g("none")],
  ["dev", "deployed the auth middleware changes", mv(["b08"], "shipped")],
  ["big", "sent Dana my notes on her deck", mv(["k14"], "done")],
  ["big", "let's do the shed cleanout this week", mv(["k06"], "week")],
  ["big", "the kitchen faucet is fixed", mv(["k21"], "done")],
  ["big", "found a contractor for the deck", mv(["k22"], "done")],
  ["big", "I'm writing the newsletter now", mv(["k15"], "doing")],
  ["big", "picked up my prescription and turned in the expense report", mv(["k17", "k12"], "done")],
];

export const CASES: Case[] = RAW.map(([board, msg, gold], i) => ({ id: `q${String(i + 1).padStart(2, "0")}`, board, msg, gold }));
