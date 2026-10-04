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
import { BOARD_TOOLS, describeHits, SEARCH_TOOL, TOOL_NAMES, type SearchResult, type ToolName, type ToolOutcome } from "./tools";
import { TOOL_DOCS, type McpToolName } from "./tool-docs";

export const MCP_PATH = "/tasks/mcp";

// The Connect page lists the tools in tool-docs.ts, so that list has to be exactly what's
// registered below: the board tools from tools.ts, search, and the ones written out here by
// hand. If tool-docs.ts names a tool that's in neither set, `covered` fails to compile. A new
// hand-written tool gets its description through doc(), which only takes names from this list.
const BY_HAND = ["get_board", "get_card", "ask_ceo", "claim_card", "release_card"] as const;
type Registered = ToolName | "search_cards" | (typeof BY_HAND)[number];
const covered: Exclude<McpToolName, Registered> extends never ? true : never = true;
void covered;
const doc = (name: (typeof BY_HAND)[number]) => TOOL_DOCS[name].description;

const INSTRUCTIONS = `This is the user's personal task board, laid out as kanban lanes. Call get_board to see
lanes, cards, and card ids, or search_cards to find specific cards on a big board, then use the other
tools to change it. get_board shows only the start of each card's notes and the names of its files:
call get_card for the full notes and to see attached images. The last lane is the
done lane: move a card there when the user finished it rather than deleting it. Dates
are YYYY-MM-DD. Cards can carry tags (shown as #agent); pass tag to get_board or
search_cards to see only those cards. The user can undo any change from the app.

Several agent sessions can share this board. Before you start work on a card, call claim_card with
your session id (CLAUDE_CODE_SESSION_ID in Claude Code). If it's refused, another live session has
the card: leave it and take the next one. get_board lists the cards that are claimed. Call
release_card when you finish a card or give up on it.

When you need the owner to decide something, call ask_ceo with a one-line question and 2 to 4
options instead of writing the question into the notes. They answer with one tap, and get_board
then shows the card as ANSWERED.`;

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

// What get_card sends back of a card's files. Images go as MCP image content, so the agent sees the
// screenshot; small text files go inline. Anything else is listed by name, type, and size only.
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_TYPES = /^(text\/(plain|markdown|csv)|application\/json)$/;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 32 * 1024;

function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

type Part = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export async function handleMcp(req: Request, env: Env, ctx: ExecutionContext, user: User): Promise<Response> {
  const agent = await getAgentByName(env.TodoAgent, user.id);
  const presence = env.Presence.get(env.Presence.idFromName(user.id));

  const handler = createMcpHandler(() => {
    // Every tool answers the same way on an end-to-end encrypted board: the server can't read it, so neither can an agent.
    const locked = async () => ((await agent.isSealed()) ? text(await agent.describe(), true) : null);
    const server = new McpServer({ name: "tasks", title: "Tasks", version: "1.0.0" }, { instructions: INSTRUCTIONS });

    server.registerTool("get_board", {
      title: "Get board",
      description: doc("get_board"),
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

    server.registerTool("get_card", {
      title: "Get card",
      description: doc("get_card"),
      inputSchema: z.object({
        id: z.string().describe("Card id like c1a2b"),
        files: z.boolean().optional().describe("false to list attachments without their contents. Default true"),
      }),
      annotations: { readOnlyHint: true },
    }, async (input: { id: string; files?: boolean }) => {
      const no = await locked();
      if (no) return no;
      const card = await agent.cardDetail(input.id);
      if (!card) return text(`There is no card with id ${input.id}.`, true);
      const content: Part[] = [{ type: "text", text: card.text }];
      if (input.files === false) return { content };
      let imageBytes = 0;
      for (const a of card.attachments) {
        const image = IMAGE_TYPES.has(a.type);
        if (!image && !TEXT_TYPES.test(a.type)) continue;
        if (image && (a.size > MAX_IMAGE_BYTES || imageBytes + a.size > MAX_IMAGES_TOTAL_BYTES)) {
          content.push({ type: "text", text: `[${a.id}] ${a.name} is too large to include here. The owner can open it in the app.` });
          continue;
        }
        if (!image && a.size > MAX_TEXT_BYTES) continue;
        // Keys start with the user id (attachments.ts), so this can only reach the token owner's files.
        const obj = await env.ATTACHMENTS.get(`${user.id}/${a.id}`);
        if (!obj || obj.customMetadata?.sealed === "1") {
          content.push({ type: "text", text: `[${a.id}] ${a.name} couldn't be read.` });
          continue;
        }
        if (image) {
          imageBytes += a.size;
          content.push({ type: "text", text: `[${a.id}] ${a.name}:` }, { type: "image", data: base64(new Uint8Array(await obj.arrayBuffer())), mimeType: a.type });
        } else {
          content.push({ type: "text", text: `[${a.id}] ${a.name}:\n${await obj.text()}` });
        }
      }
      return { content };
    });

    server.registerTool("ask_ceo", {
      title: "Ask the owner",
      description: doc("ask_ceo"),
      inputSchema: z.object({
        id: z.string().describe("Card id like c1a2b"),
        question: z.string().min(1).max(240).describe("One line, ending in a question mark"),
        options: z.array(z.string().min(1).max(140)).min(2).max(4).describe("2 to 4 answers to choose from. The owner can also type something else"),
        recommended: z.number().int().min(1).max(4).optional().describe("Which option you recommend, counting from 1"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async (input: { id: string; question: string; options: string[]; recommended?: number }) => {
      const no = await locked();
      if (no) return no;
      const r = (await agent.askCeo({ ...input, recommended: input.recommended === undefined ? undefined : input.recommended - 1 })) as ToolOutcome;
      return r.ok ? text(`${r.summary}\n\nWaiting on the owner:\n${r.board}`) : text(r.summary, true);
    });

    server.registerTool("claim_card", {
      title: "Claim card",
      description: doc("claim_card"),
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
      const r = await presence.claim(user.id, { cardId: input.id, sessionId: input.session_id, title, agent: input.agent, machine: input.machine, project: input.project });
      if (r.ok) return text(`Claimed "${title}" [${input.id}] for session ${input.session_id}.`);
      return text(`"${title}" [${input.id}] is already claimed by ${describeSession(r.session, Date.now())}. Leave it and take another card.`, true);
    });

    server.registerTool("release_card", {
      title: "Release card",
      description: doc("release_card"),
      inputSchema: z.object({
        id: z.string().describe("Card id like c1a2b"),
        session_id: z.string().min(6).max(80).describe("The session id you claimed it with"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (input: { id: string; session_id: string }) => {
      const no = await locked();
      if (no) return no;
      const released = await presence.release({ cardId: input.id, sessionId: input.session_id, title: (await agent.cardTitle(input.id)) ?? undefined });
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
        // The whole board after every write cost agents thousands of tokens a call. The lane counts
        // say the change landed; get_board and get_card are there for anything more.
        if (!r.ok) return text(r.summary, true);
        // New cards come back with their ids, so the caller can claim, move, or link them without another lookup.
        const made = r.ids?.length ? `\nNew card ids, in the order given: ${r.ids.join(", ")}` : "";
        return text(`${r.summary}${made}\n\nBoard now: ${await agent.laneCounts()}`);
      });
    }
    return server;
  }, { route: MCP_PATH });

  const res = await handler(req, env, ctx);
  // An MCP request that went through means an agent is connected: the token was good and the
  // client spoke the protocol. The handshake counts, so the app says so as soon as the agent is
  // added, before it has touched a card. The board keeps the first time only (TodoAgent.noteAgentSeen).
  if (req.method === "POST" && res.ok) {
    ctx.waitUntil(Promise.resolve(agent.noteAgentSeen()).catch((e: Error) => console.warn("noting the agent failed", e.message)));
  }
  return res;
}
