// What the app needs to know when the board on screen is someone else's (// TEAM_BOARDS in the
// README). Everything here is driven by what the server said: the answer from
// `GET /api/board/access`, then the `tasks_access` frames on the board's socket. Nothing here
// decides a role; it only turns the server's answer into what to show and what to say.

import { createContext, useContext } from "react";
import type { By, Card } from "../shared";

/** A member's way into someone else's board, as the server reports it. */
export type MemberAccess = {
  board: string;
  ownerEmail: string;
  /** What the invite granted. */
  role: "viewer" | "writer";
  /** What it's worth right now: a writer is a viewer while the owner's plan is lapsed. */
  effective: "viewer" | "writer";
  reason: null | "plan_lapsed";
};

/** `GET /api/boards`: your own board, and the ones shared with you. */
export type Boards = {
  own: { board: string; email: string; plan: "free" | "pro" };
  shared: (MemberAccess & { plan: "free" | "pro"; since: number | null })[];
};

/** What the person looking at a board may do there. The owner: anything. A writer: cards. A viewer: look. */
export type Mode = "owner" | "writer" | "viewer";
export const modeOf = (a: MemberAccess | null): Mode => (!a ? "owner" : a.effective === "writer" ? "writer" : "viewer");

/** The server's answer as a MemberAccess, or null when it isn't a member's (no way in, or the owner's own). */
export function asMemberAccess(a: unknown): MemberAccess | null {
  const v = a as Partial<MemberAccess> | null;
  if (!v || typeof v.board !== "string" || typeof v.ownerEmail !== "string") return null;
  if (v.role !== "viewer" && v.role !== "writer") return null;
  if (v.effective !== "viewer" && v.effective !== "writer") return null;
  return { board: v.board, ownerEmail: v.ownerEmail, role: v.role, effective: v.effective, reason: v.reason === "plan_lapsed" ? "plan_lapsed" : null };
}

/** `?board=<id>` in the address, or null for your own board. The id isn't a secret: the server's check is the lock. */
export function boardFromUrl(myId: string): string | null {
  const b = new URLSearchParams(location.search).get("board");
  return b && b !== myId ? b : null;
}

/** The short word on the role chip. */
export const roleWord = (a: MemberAccess) => (a.reason === "plan_lapsed" && a.role === "writer" ? "view only" : a.role);

/** What a role lets you do, in one plain line. The invite page and the board's banner both say it. */
export const ROLE_LINE = {
  viewer: "You can read the board and download its files. You can't change anything.",
  writer: "You can add, edit, move, and delete cards and attach files. Lanes, undo, and board settings stay with the owner.",
} as const;

/** The line under the top bar of a shared board: whose it is, what you can do, and what would change that. */
export function bannerText(a: MemberAccess): { lead: string; rest: string } {
  const o = a.ownerEmail;
  if (a.role === "writer" && a.reason === "plan_lapsed") {
    return { lead: `${o}'s board is view only for now.`, rest: "Their Pro plan lapsed. Nothing was deleted, and you can change cards again when the plan is back." };
  }
  if (a.effective === "writer") {
    return { lead: `You're a writer on ${o}'s board.`, rest: "You can change cards. Lanes, undo, questions, and board settings are the owner's." };
  }
  return { lead: `You're viewing ${o}'s board. View only.`, rest: `To change cards, ask ${o} to make you a writer.` };
}

/** What to say when the server changes a member's access while the board is open. Null when nothing they'd notice changed. */
export function accessChangeText(was: MemberAccess, now: MemberAccess): string | null {
  const o = now.ownerEmail;
  const lapsed = now.reason === "plan_lapsed";
  if (was.role !== now.role) {
    if (now.role === "viewer") return `${o} changed your role to viewer. You can look at this board, not change it.`;
    return lapsed
      ? `${o} made you a writer. The board is view only until their Pro plan is back, then you can change cards.`
      : `${o} made you a writer. You can add, edit, and move cards now.`;
  }
  if (was.reason !== now.reason && now.role === "writer") {
    return lapsed
      ? `${o}'s Pro plan lapsed, so this board is view only for now. Writing comes back when the plan does.`
      : `${o}'s Pro plan is back. You can change cards again.`;
  }
  return null;
}

/** Why the server turned a writer's change down, when the app can say it before they try. */
export const ASK_HOLDS = (owner: string) => `This card has a question waiting on ${owner}. It can't be finished or deleted until they answer.`;

// ── Who made the last change ────────────────────────────────────────────────────────────────

/**
 * Set while the board is shared: you're a member of it, or someone other than you has changed
 * a card on it. A board that only its owner has ever touched leaves this null and shows no
 * names, so a solo board looks the way it always has.
 */
export const WhoContext = createContext<{ me: string; now: number } | null>(null);

export function ago(at: string | number, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(at).getTime()) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 30 * 86400) return `${Math.round(s / 86400)}d ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** "dana@example.com via MCP": whose change it was, and how it was made when it wasn't by hand (their agent over MCP, or the assistant on their message). */
export function whoText(by: By, me: string): string {
  const who = by.email === me ? "you" : by.email;
  if (by.via === "agent") return `${who} via MCP`;
  if (by.via === "assistant") return `${who} via the assistant`;
  return who;
}

const verb = (c: Card) => (c.createdAt === c.updatedAt ? "Added" : "Edited");

/** In the open card: "Edited by dana@example.com · 3m ago". Nothing on a board that isn't shared, or a card from before names were kept. */
export function ByLine({ card }: { card: Card }) {
  const who = useContext(WhoContext);
  if (!who || !card.by) return null;
  return (
    <div className="by-line" title={new Date(card.updatedAt).toLocaleString()}>
      {verb(card)} by <b>{whoText(card.by, who.me)}</b> · {ago(card.updatedAt, who.now)}
    </div>
  );
}

/** On the card face, only when the last change wasn't yours by hand: that's the one worth a line. */
export function ByFace({ card }: { card: Card }) {
  const who = useContext(WhoContext);
  if (!who || !card.by || (card.by.email === who.me && !card.by.via)) return null;
  const text = whoText(card.by, who.me);
  return (
    <div className="card-by" title={`${verb(card)} by ${text}, ${new Date(card.updatedAt).toLocaleString()}`}>
      <span className="card-by-who">{text}</span><span className="card-by-when">· {ago(card.updatedAt, who.now)}</span>
    </div>
  );
}
