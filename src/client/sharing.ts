// How sharing a board works, in plain answers. The terms page, the pricing section, and the
// Members dialog all print these, so the three can't drift apart. Keep them true to
// // TEAM_BOARDS in the README. The one number in here, how many people a board holds, is
// never typed in: it's MAX_BOARD_MEMBERS, by way of GET /api/plans or the members list.

import { useEffect, useState } from "react";
import type { Plans } from "../billing";
import { api } from "./base";

export type Fact = { q: string; a: string };

/** `members` is the cap, or null when it isn't known (the plans didn't load, or Pro isn't on sale). */
export function sharingFacts(members: number | null): Fact[] {
  return [
    {
      q: "What does sharing cost?",
      a: "It's part of Pro, and only the board's owner pays. The people you invite join free: they need a Tasks account for the address you invited, and nothing else.",
    },
    {
      q: "How many people can be on a board?",
      a: members
        ? `Up to ${members}, not counting the owner. An invite that hasn't been accepted yet holds one of the ${members} places.`
        : "There's a limit per board, and an invite that hasn't been accepted yet counts toward it. The Members dialog shows the number.",
    },
    {
      q: "What happens if Pro ends?",
      a: "Nobody is removed and nothing is deleted. Everyone on the board drops to view only, writers included, and new invites are off. The roles you gave come back when Pro does. Boards people have open follow within a second of the payment system telling us, and within about half a minute at worst.",
    },
    {
      q: "Who owns the cards?",
      a: "The board and every card on it belong to the board's owner, whoever added them. A writer's cards stay when the writer leaves or is removed, and still show who added or last changed them.",
    },
    {
      q: "Can a member give my agents work?",
      a: "No. The tags your agents act on (#agent, #gauntlet, #needs-ceo, #ship-ok) are yours alone: a member can't put one on a card or take one off, and a card that carries #agent or #gauntlet is read only to members. Only you can answer an agent's question.",
    },
    {
      q: "Can a board have two owners?",
      a: "No, not in this version. A board has one owner, and it can't be handed to someone else.",
    },
    {
      q: "Can a viewer export or copy the board?",
      a: "A viewer can read everything on it, notes and attached files included, and download the files. Members have no export button, but nothing stops a person who can read something from copying it. Invite people you'd hand the board to.",
    },
    {
      q: "Who can see what happened?",
      a: "Only the owner reads the audit log: every invite, role change, removal, and exit, and who deleted which card.",
    },
  ];
}

/** GET /api/plans: undefined while loading, null when it didn't load. */
export function usePlans(): Plans | null | undefined {
  const [plans, setPlans] = useState<Plans | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    fetch(api("/api/plans")).then((r) => (r.ok ? (r.json() as Promise<Plans>) : null)).then((p) => { if (live) setPlans(p); }).catch(() => { if (live) setPlans(null); });
    return () => { live = false; };
  }, []);
  return plans;
}
