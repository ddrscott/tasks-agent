// The board as an MCP server, so outside agents (Glean, Claude Code, Cursor, VS Code,
// Codex, Claude.ai, ChatGPT, …) can read and change it. Served at /tasks/mcp over
// Streamable HTTP. The OAuth provider in server.ts checks the bearer token first,
// which is either an OAuth access token or a personal access token (tokens.ts), and
// hands over the user it belongs to. Every request is stateless: the user picks
// their TodoAgent, and each tool call runs over RPC through the same board tools the
// in-app assistant uses. Changes show up live in any open tab and can be undone like
// any other change.

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getAgentByName } from "agents";
import { createMcpHandler } from "agents/mcp/server";
import type { User } from "./auth";
import { describeSession } from "./presence";
import { BOARD_TOOLS, describeHits, SEARCH_TOOL, TOOL_NAMES, type SearchResult, type ToolOutcome } from "./tools";

export const MCP_PATH = "/tasks/mcp";

const INSTRUCTIONS = `This is the user's personal task board, laid out as kanban lanes. Call get_board to see
lanes, cards, and card ids, or search_cards to find specific cards on a big board, then use the other
tools to change it. The last lane is the
done lane: move a card there when the user finished it rather than deleting it. Dates
are YYYY-MM-DD. Cards can carry tags (shown as #agent); pass tag to get_board or
search_cards to see only those cards. The user can undo any change from the app.

Several agent sessions can share this board. Before you start work on a card, call claim_card with
your session id (CLAUDE_CODE_SESSION_ID in Claude Code). If it's refused, another live session has
the card: leave it and take the next one. get_board lists the cards that are claimed. Call
release_card when you finish a card or give up on it.`;

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

export async function handleMcp(req: Request, env: Env, ctx: ExecutionContext, user: User): Promise<Response> {
  const agent = await getAgentByName(env.TodoAgent, user.id);
  const presence = env.Presence.get(env.Presence.idFromName(user.id));

  const handler = createMcpHandler(() => {
    // Every tool answers the same way on an end-to-end encrypted board: the server can't read it, so neither can an agent.
    const locked = async () => ((await agent.isSealed()) ? text(await agent.describe(), true) : null);
    const server = new McpServer({ name: "tasks", title: "Tasks", version: "1.0.0" }, { instructions: INSTRUCTIONS });

    server.registerTool("get_board", {
      title: "Get board",
      description: "Show every lane and card on the board, with ids, due dates, tags, and notes. Pass tag to list only the cards carrying it.",
      inputSchema: z.object({ tag: z.string().optional().describe("Only cards with this tag, like agent") }),
      annotations: { readOnlyHint: true },
    }, async (input: { tag?: string }) => {
      const no = await locked();
      if (no) return no;
      const board = await agent.describe(input?.tag);
      // Claims sit beside the board, not in it (presence.ts), so they're added here.
      const view = await presence.view();
      const lines: string[] = [];
      for (const c of view.claims) {
        const title = await agent.cardTitle(c.cardId);
        if (title === null) continue;
        lines.push(`  - [${c.cardId}] ${title} — claimed by ${describeSession(view.sessions.find((s) => s.id === c.sessionId) ?? null, view.now)}`);
      }
      return text(lines.length ? `${board}\nClaimed by a live session (skip these unless the session is yours):\n${lines.join("\n")}` : board);
    });

    server.registerTool("claim_card", {
      title: "Claim card",
      description:
        "Claim a card for your session before you work on it, so two agents never take the same one. " +
        "Refused while another live session holds the card; that answer names the holder. " +
        "A claim lapses 15 minutes after its session was last heard from, and calling this again renews yours.",
      inputSchema: z.object({
        id: z.string().describe("Card id like c1a2b"),
        session_id: z.string().min(6).max(80).regex(/^[\w.:-]+$/).describe("Your session id. In Claude Code: the CLAUDE_CODE_SESSION_ID environment variable"),
        agent: z.string().max(40).optional().describe("What you are, like lead"),
        machine: z.string().max(60).optional().describe("The machine you run on, when you know it"),
        project: z.string().max(80).optional().describe("The folder you're working in, when you know it"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (input: { id: string; session_id: string; agent?: string; machine?: string; project?: string }) => {
      const no = await locked();
      if (no) return no;
      const title = await agent.cardTitle(input.id);
      if (title === null) return text(`There is no card with id ${input.id}.`, true);
      const r = await presence.claim(user.id, { cardId: input.id, sessionId: input.session_id, agent: input.agent, machine: input.machine, project: input.project });
      if (r.ok) return text(`Claimed "${title}" [${input.id}] for session ${input.session_id}.`);
      return text(`"${title}" [${input.id}] is already claimed by ${describeSession(r.session, Date.now())}. Leave it and take another card.`, true);
    });

    server.registerTool("release_card", {
      title: "Release card",
      description: "Give up your claim on a card, when you finish it or stop working on it. Only the session holding the claim can release it.",
      inputSchema: z.object({
        id: z.string().describe("Card id like c1a2b"),
        session_id: z.string().min(6).max(80).describe("The session id you claimed it with"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (input: { id: string; session_id: string }) => {
      const no = await locked();
      if (no) return no;
      const released = await presence.release({ cardId: input.id, sessionId: input.session_id });
      return text(released ? `Released [${input.id}].` : `Session ${input.session_id} doesn't hold a claim on [${input.id}].`);
    });

    server.registerTool(SEARCH_TOOL.name, {
      title: "Search cards",
      description: SEARCH_TOOL.description,
      inputSchema: SEARCH_TOOL.inputSchema,
      annotations: { readOnlyHint: true },
    }, async (input: unknown) => {
      const no = await locked();
      if (no) return no;
      try {
        return text(describeHits((await agent.search(input)) as SearchResult));
      } catch (e) {
        return text((e as Error).message, true);
      }
    });

    for (const name of TOOL_NAMES) {
      const t = BOARD_TOOLS[name];
      server.registerTool(name, {
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: { readOnlyHint: false, destructiveHint: !!t.destructive, idempotentHint: false, openWorldHint: false },
      }, async (input: unknown) => {
        const no = await locked();
        if (no) return no;
        const r = (await agent.runTool(name, input, undefined, "agent")) as ToolOutcome;
        return r.ok ? text(`${r.summary}\n\nBoard now:\n${r.board}`) : text(r.summary, true);
      });
    }
    return server;
  }, { route: MCP_PATH });

  return handler(req, env, ctx);
}
