// The board as an MCP server, so outside agents (Glean, Claude Code, Cursor, VS Code,
// Codex, Claude.ai, ChatGPT, …) can read and change it. Served at /tasks/mcp over
// Streamable HTTP. The OAuth provider in server.ts checks the bearer token first,
// which is either an OAuth access token or a personal access token (tokens.ts), and
// hands over the user it belongs to. Every request is stateless: the user picks
// their TodoAgent, and each tool call runs over RPC through the same board tools the
// in-app assistant uses. Changes show up live in any open tab and can be undone like
// any other change.

import { McpServer } from "@modelcontextprotocol/server";
import { getAgentByName } from "agents";
import { createMcpHandler } from "agents/mcp/server";
import type { User } from "./auth";
import { BOARD_TOOLS, describeHits, SEARCH_TOOL, TOOL_NAMES, type SearchResult, type ToolOutcome } from "./tools";

export const MCP_PATH = "/tasks/mcp";

const INSTRUCTIONS = `This is the user's personal task board, laid out as kanban lanes. Call get_board to see
lanes, cards, and card ids, or search_cards to find specific cards on a big board, then use the other
tools to change it. The last lane is the
done lane: move a card there when the user finished it rather than deleting it. Dates
are YYYY-MM-DD. The user can undo any change from the app.`;

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

export async function handleMcp(req: Request, env: Env, ctx: ExecutionContext, user: User): Promise<Response> {
  const agent = await getAgentByName(env.TodoAgent, user.id);

  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: "tasks", title: "Tasks", version: "1.0.0" }, { instructions: INSTRUCTIONS });

    server.registerTool("get_board", {
      title: "Get board",
      description: "Show every lane and card on the board, with ids, due dates, and notes.",
      annotations: { readOnlyHint: true },
    }, async () => text(await agent.describe()));

    server.registerTool(SEARCH_TOOL.name, {
      title: "Search cards",
      description: SEARCH_TOOL.description,
      inputSchema: SEARCH_TOOL.inputSchema,
      annotations: { readOnlyHint: true },
    }, async (input: unknown) => {
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
        const r = (await agent.runTool(name, input)) as ToolOutcome;
        return r.ok ? text(`${r.summary}\n\nBoard now:\n${r.board}`) : text(r.summary, true);
      });
    }
    return server;
  }, { route: MCP_PATH });

  return handler(req, env, ctx);
}
