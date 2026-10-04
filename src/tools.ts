// The board tools, defined once. The in-app assistant (agent.ts) and outside agents
// connecting over MCP (mcp.ts) both call these, so they change the board the same way.
// Each tool is a pure function from the current board to the next one plus a
// one-line summary for whoever called it.

import { z } from "zod";
import * as ops from "./shared";
import type { Board } from "./shared";
import { TOOL_DOCS, type McpToolName } from "./tool-docs";

/** `ids` are the cards a tool created, for callers that need to refer to them next (MCP agents). */
type Result = { board: Board; summary: string; ids?: string[] };

type BoardTool<S extends z.ZodType> = {
  description: string;
  /** Undo label shown in the app. */
  label: string;
  inputSchema: S;
  apply(b: Board, input: z.infer<S>): Result;
  /** Destructive tools are flagged for clients that ask before running them. */
  destructive?: boolean;
};

// What a tool is for, and whether it destroys anything, comes from tool-docs.ts, the same
// entries the Connect page lists. A board tool with no entry there doesn't compile.
const define = <S extends z.ZodType>(name: McpToolName, t: Omit<BoardTool<S>, "description" | "destructive">): BoardTool<S> => {
  const doc: { description: string; destructive?: boolean } = TOOL_DOCS[name];
  return { ...t, description: doc.description, destructive: doc.destructive };
};

const TAGS_HINT = "Short labels like agent or client, lower case, no #. Only when the user or your own instructions call for one.";

export const BOARD_TOOLS = {
  add_cards: define("add_cards", {
    label: "Agent added cards",
    inputSchema: z.object({
      cards: z.array(z.object({
        title: z.string().describe("Short task title, sentence case"),
        lane: z.string().optional().describe("Lane name or id; defaults to the first lane"),
        notes: z.string().optional(),
        due: z.string().optional().describe("YYYY-MM-DD, only if the user gave a date"),
        tags: z.array(z.string()).optional().describe(TAGS_HINT),
      })).min(1),
    }),
    apply: (b, { cards }) => {
      const ids: string[] = [];
      const board = cards.reduce((acc, c) => {
        const r = ops.addCard(acc, { title: c.title, laneId: c.lane, notes: c.notes, due: c.due, tags: c.tags });
        ids.push(r.card.id);
        return r.board;
      }, b);
      return { board, summary: `Added ${quoteList(cards.map((c) => c.title))}`, ids };
    },
  }),
  move_cards: define("move_cards", {
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
  update_card: define("update_card", {
    label: "Agent edited a card",
    inputSchema: z.object({
      id: z.string(),
      title: z.string().optional(),
      notes: z.string().optional(),
      due: z.string().nullable().optional().describe("YYYY-MM-DD or null"),
      tags: z.array(z.string()).optional().describe(TAGS_HINT),
    }),
    apply: (b, { id, ...patch }) => ({
      board: ops.updateCard(b, id, patch),
      summary: `Updated ${quoteList(titlesOf(b, [id]))}`,
    }),
  }),
  delete_cards: define("delete_cards", {
    label: "Agent deleted cards",
    inputSchema: z.object({ ids: z.array(z.string()).min(1) }),
    apply: (b, { ids }) => ({ board: ops.deleteCards(b, ids), summary: `Deleted ${quoteList(titlesOf(b, ids))}` }),
  }),
  add_lane: define("add_lane", {
    label: "Agent added a lane",
    inputSchema: z.object({ name: z.string() }),
    apply: (b, { name }) => ({ board: ops.addLane(b, name).board, summary: `Added lane "${name}"` }),
  }),
  rename_lane: define("rename_lane", {
    label: "Agent renamed a lane",
    inputSchema: z.object({ lane: z.string().describe("Current lane name or id"), name: z.string() }),
    apply: (b, { lane, name }) => ({ board: ops.renameLane(b, lane, name), summary: `Renamed lane to "${name}"` }),
  }),
  delete_lane: define("delete_lane", {
    label: "Agent deleted a lane",
    inputSchema: z.object({ lane: z.string() }),
    apply: (b, { lane }) => ({ board: ops.deleteLane(b, lane), summary: `Deleted lane "${lane}"` }),
  }),
};

export type ToolName = keyof typeof BOARD_TOOLS;
export const TOOL_NAMES = Object.keys(BOARD_TOOLS) as ToolName[];

/** Read-only search, shared by the in-app assistant and MCP. Runs TodoAgent.search. */
export const SEARCH_TOOL = {
  name: "search_cards" satisfies McpToolName,
  description: TOOL_DOCS.search_cards.description,
  inputSchema: z.object({
    query: z.string().min(1).describe("What to look for, in plain words"),
    mode: z.enum(["hybrid", "keyword", "semantic"]).optional()
      .describe("hybrid (default) mixes exact words and meaning; keyword matches words; semantic matches meaning"),
    lane: z.string().optional().describe("Only search this lane (name or id)"),
    tag: z.string().optional().describe("Only cards with this tag, like agent"),
    limit: z.number().int().min(1).max(50).optional().describe("Most results to return, default 10"),
  }),
};

export type SearchInput = z.infer<typeof SEARCH_TOOL.inputSchema>;
export type SearchHit = {
  id: string;
  title: string; // with \u0001…\u0002 around keyword matches
  snippet: string; // from the notes, marked the same way; empty when the notes didn't match
  lane: string;
  due: string | null;
  match: "keyword" | "semantic" | "both";
};
export type SearchResult = { hits: SearchHit[]; semantic: "on" | "unavailable" | "off" };

/** Plain-text search results for a model: one line per card. */
export function describeHits(r: SearchResult): string {
  const strip = (s: string) => s.replace(/[\u0001\u0002]/g, "");
  if (!r.hits.length) return "No matching cards.";
  return r.hits.map((h) =>
    `- [${h.id}] ${strip(h.title)} (${h.lane}${h.due ? `, due ${h.due}` : ""}; ${h.match} match)${h.snippet ? ` — …${strip(h.snippet)}…` : ""}`,
  ).join("\n") + (r.semantic === "unavailable" ? "\n(Meaning-based search is unavailable right now; these are keyword matches only.)" : "");
}

/** What every tool call returns: a summary plus the fresh board, so the caller never works from a stale picture. */
export type ToolOutcome = { ok: true; summary: string; board: string; ids?: string[] } | { ok: false; summary: string };

function titlesOf(b: Board, ids: string[]): string[] {
  return ids.map((id) => b.cards.find((c) => c.id === id)?.title ?? id);
}

function quoteList(items: string[]): string {
  const q = items.map((t) => `"${t}"`);
  return q.length <= 3 ? q.join(", ") : `${q.slice(0, 2).join(", ")} and ${q.length - 2} more`;
}
