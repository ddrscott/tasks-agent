// What the demo board at /tasks/demo starts with, and the script its pretend agent follows
// (Demo.tsx). All of it is made up: a small shop with three repos and a few agent sessions.
// Nothing here is fetched or saved; a reload builds it again from scratch.

import { NEEDS_CEO_TAG, type Ask, type Board, type Card } from "../shared";
import type { Claim, Session } from "../presence-shared";
import type { Presence } from "./Sessions";

const MIN = 60_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

/** A day near today, as YYYY-MM-DD in local time, so the due chips read Today and Tomorrow. */
function day(offset: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** One question the scripted agent asks, and what it says once it has the answer. */
export type Beat = {
  cardId: string;
  ask: Omit<Ask, "askedAt">;
  /** The status line when it picks the card up, before it asks. */
  pickup: string;
  /** The status line once it's acting on the answer. `heard` is how it got one: `got your answer ("…")`. */
  working(heard: string): string;
  /** The status line when the card goes to Done. `went` is the option it acted on. */
  done(went: string): string;
  /** The session's last-action line at each point. */
  last: { reading: string; working: string };
};

/** The lead session works these cards in order. The first one starts out claimed, with its question open. */
export const PLOT: Beat[] = [
  {
    cardId: "c-orders",
    ask: {
      question: "The old orders.total column: drop it in this migration, or keep it a week?",
      options: ["Keep it a week, drop it in a follow-up", "Drop it now", "Keep it for good"],
      recommended: 0,
    },
    pickup: "STATUS: picked up — reading the schema",
    working: (heard) => `STATUS: working — ${heard}, running the migration on staging`,
    done: (a) => `STATUS: done — orders is on the new schema. Went with: ${a}`,
    last: { reading: "Read: schema.sql", working: "Bash: npm run migrate -- --env staging" },
  },
  {
    cardId: "c-ratelimit",
    ask: {
      question: "Rate limit search per API key or per IP?",
      options: ["Per API key, 60 a minute", "Per IP, 60 a minute", "Both: key first, IP as the fallback"],
      recommended: 0,
    },
    pickup: "STATUS: picked up — reading the search handler",
    working: (heard) => `STATUS: working — ${heard}, writing the limiter and its tests`,
    done: (a) => `STATUS: done — search is rate limited, tests pass. Went with: ${a}`,
    last: { reading: "Read: search.ts", working: "Edit: rate-limit.ts" },
  },
];

/** The status line when the visitor moves the agent's card to Done before the agent got there. */
export const CLOSED_BY_YOU = "STATUS: done — you closed this one, so I took my question back and stopped";

/** Swap a note's STATUS line for a new one, or put one on top when it has none. */
export function withStatus(notes: string, line: string): string {
  // A function, so a "$&" typed into an answer lands in the note as typed.
  if (/^STATUS:.*$/m.test(notes)) return notes.replace(/^STATUS:.*$/m, () => line);
  return notes ? `${line}\n\n${notes}` : line;
}

/** Check off what's left of a card's checklist, for when the agent finishes it. */
export const allChecked = (notes: string) => notes.replace(/^(\s*[-*] )\[ \]/gm, "$1[x]");

export function seedBoard(theme: string): Board {
  const card = (c: Pick<Card, "id" | "title" | "laneId"> & Partial<Card>, minutesAgo: number): Card => ({
    notes: "", due: null, createdAt: iso((minutesAgo + 90) * MIN), updatedAt: iso(minutesAgo * MIN), ...c,
  });
  const first = PLOT[0];
  return {
    theme,
    // Agents have been at this board for a while, so nothing on it says "No agent connected yet".
    agentSeenAt: iso(2900 * MIN),
    lanes: [
      { id: "todo", name: "To do" },
      { id: "doing", name: "Doing" },
      { id: "done", name: "Done" },
    ],
    cards: [
      card({
        id: "c-ratelimit", laneId: "todo", title: "Rate limit the public search endpoint", tags: ["shop-api", "agent"],
        notes: "Somebody scraped `/search` all weekend. Cap it before it happens again.\n\n- [ ] Limiter in front of `/search`\n- [ ] Return 429 with a `Retry-After` header\n- [ ] Tests",
      }, 300),
      card({
        id: "c-footer", laneId: "todo", title: "Checkout button sits on top of the footer on small phones", tags: ["shop-web"], due: day(0),
        notes: "Seen on an iPhone SE. The pay button covers the terms link.",
      }, 180),
      card({ id: "c-node", laneId: "todo", title: "Move CI from Node 20 to Node 22", tags: ["infra", "agent"], due: day(4) }, 1500),
      card({
        id: "c-password", laneId: "todo", title: "Rotate the staging database password", tags: ["infra"], due: day(1),
      }, 2900),
      {
        ...card({
          id: "c-orders", laneId: "doing", title: "Migrate the orders table to the new schema", tags: ["shop-api", "agent", NEEDS_CEO_TAG],
          notes: [
            "STATUS: blocked on a decision — the migration is written and passes on a copy of prod",
            "",
            "## So far",
            "- [x] Wrote `migrations/0042_orders_v2.sql`",
            "- [x] Ran it on last night's snapshot: 38 seconds, no errors",
            "- [ ] Run it on staging, then production",
            "- [ ] Decide what happens to `orders.total`",
            "",
            "## Why I'm asking",
            "The new schema computes the total from line items, so `orders.total` isn't read anymore.",
            "Keeping it a week leaves a way back if the numbers disagree.",
          ].join("\n"),
        }, 2),
        ask: { ...first.ask, askedAt: iso(2 * MIN) },
      },
      card({
        id: "c-flaky", laneId: "doing", title: "Fix the flaky cart total test", tags: ["shop-web", "agent"],
        notes: [
          "STATUS: working — reproduced it: fails about 1 run in 12",
          "",
          "The price fetch mock resolves after the first render, so the total is sometimes read too early.",
          "",
          "- [x] Reproduce it",
          "- [ ] Wait for the price in the test instead of sleeping",
          "- [ ] Run it 200 times to be sure",
        ].join("\n"),
      }, 1),
      card({
        id: "c-writeup", laneId: "doing", title: "Write up Tuesday's checkout outage", tags: ["infra"], due: day(1),
        notes: "Timeline is in the incident channel. Still need the part about why the alert didn't page anyone.",
      }, 240),
      card({
        id: "c-webhook", laneId: "done", title: "Retry failed webhooks with backoff", tags: ["shop-api", "agent"],
        notes: [
          "ANSWER: Five tries over an hour (asked: How long should webhook retries keep going?)",
          "",
          "STATUS: done — retries at 1, 5, 15, 30, and 60 minutes, then the event is marked failed",
          "",
          "- [x] Retry queue",
          "- [x] Backoff schedule",
          "- [x] Tests for the give-up case",
        ].join("\n"),
      }, 1300),
      card({
        id: "c-darkmode", laneId: "done", title: "Dark mode for the order history page", tags: ["shop-web", "agent"],
        notes: "STATUS: done — follows the system setting, checked in Safari and Chrome",
      }, 1700),
      card({
        id: "c-bucket", laneId: "done", title: "Put the staging bucket under Terraform", tags: ["infra", "agent"],
        notes: "STATUS: done — imported the bucket, plan shows no changes",
      }, 2600),
    ],
  };
}

const LEAD = "7c1e4f2a-93b6-4d0e-a5c8-2f6b1d9e0a41";

/** Which point of the script the lead session is at, worked out from the board (Demo.tsx). */
export type Scene =
  | { at: "idle" } // nothing left in the script
  | { at: "between" } // about to take the next card
  // On a card: reading before it asks, waiting on the answer, heard it a moment ago, or working on it.
  | { at: "reading" | "waiting" | "heard" | "working"; beat: Beat; card: Card };

/**
 * The three sessions the Sessions list shows. Two never change: one working, one idle. The lead
 * session in shop-api follows the scene: it says needs input exactly while its card has a
 * question open, so answering one puts it back to working in the same moment.
 */
export function demoPresence(scene: Scene, now: number, startedAt: number): Presence {
  const recent = (t: number) => Math.max(t, now - 4 * MIN); // nothing here ever goes stale
  const leadNow = (): Pick<Session, "state" | "last" | "seenAt"> => {
    if (scene.at === "idle") return { state: "idle", last: "finished its turn", seenAt: recent(startedAt) };
    if (scene.at === "between") return { state: "working", last: "tasks: get_board", seenAt: now - 2000 };
    if (scene.at === "waiting") {
      return { state: "needs-input", last: `asked: ${scene.card.ask?.question ?? scene.beat.ask.question}`, seenAt: recent(Date.parse(scene.card.updatedAt)) };
    }
    if (scene.at === "heard") return { state: "working", last: "tasks: get_card", seenAt: now - 1000 };
    return { state: "working", last: scene.beat.last[scene.at], seenAt: now - 3000 };
  };
  const sessions: Session[] = [
    { id: LEAD, project: "shop-api", machine: "macbook", agent: "lead", cwd: "~/code/shop-api", link: "", startedAt: startedAt - 52 * MIN, ...leadNow() },
    {
      id: "b40a9d17-5e2c-4c7f-8a31-6d0f3e5b7c92", project: "shop-web", machine: "macbook", agent: "lead", cwd: "~/code/shop-web", link: "",
      state: "working", last: "Bash: npm test -- cart", startedAt: startedAt - 18 * MIN, seenAt: now - 4000,
    },
    {
      id: "e2f8c630-1a7d-4b95-b0e4-9c5a7d3f1e68", project: "infra", machine: "build-box", agent: "", cwd: "~/code/infra", link: "",
      state: "idle", last: "finished its turn", startedAt: startedAt - 140 * MIN, seenAt: recent(startedAt - 3 * MIN),
    },
  ];
  const claims: Claim[] = [{ cardId: "c-flaky", sessionId: sessions[1].id, agent: "lead", claimedAt: startedAt - 17 * MIN }];
  if (scene.at !== "idle" && scene.at !== "between") {
    claims.push({ cardId: scene.card.id, sessionId: LEAD, agent: "lead", claimedAt: startedAt });
  }
  return { sessions, claims, now };
}
