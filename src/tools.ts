// The board tools, defined once. The in-app assistant (agent.ts) and outside agents
// connecting over MCP (mcp.ts) both call these, so they change the board the same way.
// Each tool is a pure function from the current board to the next one plus a
// one-line summary for whoever called it.

import { z } from "zod";
import * as ops from "./shared";
import type { Board } from "./shared";

type Result = { board: Board; summary: string };

type BoardTool<S extends z.ZodType> = {
  description: string;
  /** Undo label shown in the app. */
  label: string;
  inputSchema: S;
  apply(b: Board, input: z.infer<S>): Result;
  /** Destructive tools are flagged for clients that ask before running them. */
  destructive?: boolean;
};

const define = <S extends z.ZodType>(t: BoardTool<S>) => t;

export const BOARD_TOOLS = {
  add_cards: define({
    description: "Create one or more cards. Use this for every new task the user mentions.",
    label: "Agent added cards",
    inputSchema: z.object({
      cards: z.array(z.object({
        title: z.string().describe("Short task title, sentence case"),
        lane: z.string().optional().describe("Lane name or id; defaults to the first lane"),
        notes: z.string().optional(),
        due: z.string().optional().describe("YYYY-MM-DD, only if the user gave a date"),
      })).min(1),
    }),
    apply: (b, { cards }) => ({
      board: cards.reduce((acc, c) => ops.addCard(acc, { title: c.title, laneId: c.lane, notes: c.notes, due: c.due }).board, b),
      summary: `Added ${quoteList(cards.map((c) => c.title))}`,
    }),
  }),
  move_cards: define({
    description: "Move cards to a lane, for example to Done when the user finished something.",
    label: "Agent moved cards",
    inputSchema: z.object({
      ids: z.array(z.string()).min(1).describe("Card ids like c1a2b"),
      lane: z.string().describe("Destination lane name or id"),
    }),
    apply: (b, { ids, lane }) => ({
      board: ids.reduce((acc, id) => ops.moveCard(acc, id, lane), b),
      summary: `Moved ${quoteList(titlesOf(b, ids))} → ${ops.findLane(b, lane)?.name ?? lane}`,
    }),
  }),
  update_card: define({
    description: "Change a card's title, notes, or due date. Pass due: null to clear a due date.",
    label: "Agent edited a card",
    inputSchema: z.object({
      id: z.string(),
      title: z.string().optional(),
      notes: z.string().optional(),
      due: z.string().nullable().optional().describe("YYYY-MM-DD or null"),
    }),
    apply: (b, { id, ...patch }) => ({
      board: ops.updateCard(b, id, patch),
      summary: `Updated ${quoteList(titlesOf(b, [id]))}`,
    }),
  }),
  delete_cards: define({
    description: "Permanently delete cards. Prefer moving to Done unless the user asked to delete or remove.",
    label: "Agent deleted cards",
    destructive: true,
    inputSchema: z.object({ ids: z.array(z.string()).min(1) }),
    apply: (b, { ids }) => ({ board: ops.deleteCards(b, ids), summary: `Deleted ${quoteList(titlesOf(b, ids))}` }),
  }),
  add_lane: define({
    description: "Add a new lane (column) to the right of the others.",
    label: "Agent added a lane",
    inputSchema: z.object({ name: z.string() }),
    apply: (b, { name }) => ({ board: ops.addLane(b, name).board, summary: `Added lane "${name}"` }),
  }),
  rename_lane: define({
    description: "Rename a lane.",
    label: "Agent renamed a lane",
    inputSchema: z.object({ lane: z.string().describe("Current lane name or id"), name: z.string() }),
    apply: (b, { lane, name }) => ({ board: ops.renameLane(b, lane, name), summary: `Renamed lane to "${name}"` }),
  }),
  delete_lane: define({
    description: "Delete a lane AND every card in it. Only when the user explicitly asks.",
    label: "Agent deleted a lane",
    destructive: true,
    inputSchema: z.object({ lane: z.string() }),
    apply: (b, { lane }) => ({ board: ops.deleteLane(b, lane), summary: `Deleted lane "${lane}"` }),
  }),
};

export type ToolName = keyof typeof BOARD_TOOLS;
export const TOOL_NAMES = Object.keys(BOARD_TOOLS) as ToolName[];

/** What every tool call returns: a summary plus the fresh board, so the caller never works from a stale picture. */
export type ToolOutcome = { ok: true; summary: string; board: string } | { ok: false; summary: string };

function titlesOf(b: Board, ids: string[]): string[] {
  return ids.map((id) => b.cards.find((c) => c.id === id)?.title ?? id);
}

function quoteList(items: string[]): string {
  const q = items.map((t) => `"${t}"`);
  return q.length <= 3 ? q.join(", ") : `${q.slice(0, 2).join(", ")} and ${q.length - 2} more`;
}
