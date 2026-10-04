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
import { WAIT_SECONDS, workingRules } from "./agent-rules";
import { askState } from "./shared";

export const MCP_PATH = "/tasks/mcp";

// The Connect page lists the tools in tool-docs.ts, so that list has to be exactly what's
// registered below: the board tools from tools.ts, search, and the ones written out here by
// hand. If tool-docs.ts names a tool that's in neither set, `covered` fails to compile. A new
// hand-written tool gets its description through doc(), which only takes names from this list.
const BY_HAND = ["get_started", "get_board", "get_card", "ask_ceo", "wait_for_answer", "claim_card", "release_card"] as const;
type Registered = ToolName | "search_cards" | (typeof BY_HAND)[number];
const covered: Exclude<McpToolName, Registered> extends never ? true : never = true;
void covered;
const doc = (name: (typeof BY_HAND)[number]) => TOOL_DOCS[name].description;

const INSTRUCTIONS = `This is the user's personal task board, laid out as kanban lanes. Call get_board to see
lanes, cards, and card ids, or search_cards to find specific cards on a big board, then use the other
tools to change it. get_board shows only the start of each card's notes and the names of its files:
call get_card for the full notes and to see attached images. get_board marks the
done lane, wherever it sits: move a card there when the user finished it rather than deleting it. Dates
are YYYY-MM-DD. Cards can carry tags (shown as #agent); pass tag to get_board or
search_cards to see only those cards. The user can undo any change from the app.

When you're asked to work the board, or its agent cards, on your own, call get_started first
and follow the rules it returns.

Several agent sessions can share this board. Before you start work on a card, call claim_card with
a session id (get_started hands you one; without it, make one up once and keep it), what you are
(agent), your hostname if you know it (machine), and the name of the folder you're in (project). If it's refused, another live session has
the card: leave it and take the next one. get_board lists the cards that are claimed. Call
release_card when you finish a card or give up on it. Pass the same session id to ask_ceo and
wait_for_answer: the board shows that session as waiting on the owner until they answer.

When you need the owner to decide something, call ask_ceo with a one-line question and 2 to 4
options instead of writing the question into the notes. They answer with one tap, and get_board
then shows the card as ANSWERED. Keep your claim on the card while you wait. Nothing calls you when
the answer comes: call wait_for_answer with the card's id, which holds until the answer lands. If you can't go on with a card (a tool was refused, or
something is missing), ask with ask_ceo too, so the owner sees it on the board.`;

/** How often wait_for_answer looks at the board while it holds. */
const WAIT_POLL_MS = 2000;
/** The most board reads one wait_for_answer call makes, to stay far inside a Worker's subrequest limit. */
const WAIT_MAX_READS = 30;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An id for a session that has none of its own: tasks- and 8 letters or digits. Nothing is stored until it claims. */
function newSessionId(): string {
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";
  return `tasks-${[...crypto.getRandomValues(new Uint8Array(8))].map((n) => abc[n % abc.length]).join("")}`;
}

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

    // The working rules, so the prompt a person pastes is one line (agent-rules.ts). It answers on
    // an encrypted board like every other tool: there's nothing there for an agent to work.
    server.registerTool("get_started", {
      title: "Get started",
      description: doc("get_started"),
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    }, async () => (await locked()) ?? text(workingRules(new URL(req.url).origin, "/tasks", newSessionId())));

    server.registerTool("get_board", {
      title: "Get board",
      description: doc("get_board"),
      inputSchema: z.object({ tag: z.string().optional().describe("Only cards with this tag, like agent") }),
      annotations: { readOnlyHint: true },
    }, async (input: { tag?: string }) => {
      const no = await locked();
      if (no) return no;
      const board = await agent.describe(input?.tag, user.email);
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
      const card = await agent.cardDetail(input.id, user.email);
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
        session_id: z.string().min(6).max(80).regex(/^[\w.:-]+$/).optional().describe("Your session id, the one you claimed the card with. The board shows that session as waiting on the owner"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async (input: { id: string; question: string; options: string[]; recommended?: number; session_id?: string }) => {
      const no = await locked();
      if (no) return no;
      const { session_id, ...ask } = input;
      const r = (await agent.askCeo({ ...ask, recommended: input.recommended === undefined ? undefined : input.recommended - 1 }, user.email)) as ToolOutcome;
      if (!r.ok) return text(r.summary, true);
      // Presence is told who asked, so the card and Sessions say that session needs input until the
      // owner answers. With no session_id it's whoever holds the card, which is the asker when the
      // agent claimed first, as the rules have it.
      const title = (await agent.cardTitle(input.id)) ?? undefined;
      const asker = await presence.asked(user.id, { cardId: input.id, sessionId: session_id, question: input.question, title });
      const shown = asker
        ? `The board shows session ${asker} waiting on the owner. Keep your claim on this card: don't call release_card.`
        : "No session is shown waiting on this: claim the card with claim_card and the board will say who asked.";
      return text(`${r.summary}\n${shown}\n\nWaiting on the owner:\n${r.board}`);
    });

    // Holding a request open is how every client gets to wait, with no shell and no feed. The MCP
    // server stays stateless: the Worker rereads the cards on a timer until one changes or the time
    // is up. Nothing is stored, and a client that hangs up ends the loop.
    server.registerTool("wait_for_answer", {
      title: "Wait for an answer",
      description: doc("wait_for_answer"),
      inputSchema: z.object({
        ids: z.array(z.string()).min(1).max(5).describe("The cards you asked on, like c1a2b"),
        seconds: z.number().int().min(1).max(45).optional().describe(`How long to hold at most. Default ${WAIT_SECONDS}`),
        session_id: z.string().min(6).max(80).regex(/^[\w.:-]+$/).optional().describe("Your session id, so the board knows you're still here"),
      }),
      annotations: { readOnlyHint: true },
    }, async (input: { ids: string[]; seconds?: number; session_id?: string }) => {
      const no = await locked();
      if (no) return no;
      const ids = [...new Set(input.ids)];
      // Waiting is being alive. An agent polling here makes no other call, so each call counts as
      // hearing from the session it names and from the sessions holding these cards. Without this
      // a waiting agent went stale after 5 minutes and lost its cards after 15.
      const here = () => presence.touch({ sessionIds: input.session_id ? [input.session_id] : [], cardIds: ids });
      await here();
      const total = (input.seconds ?? WAIT_SECONDS) * 1000;
      const every = Math.max(WAIT_POLL_MS, Math.ceil((total * ids.length) / WAIT_MAX_READS));
      const until = Date.now() + total;
      for (;;) {
        const waiting: string[] = [];
        const ready: string[] = [];
        for (const id of ids) {
          const card = await agent.cardDetail(id, user.email);
          const state = card ? askState(card.text) : null;
          // A card the owner moved to the done lane is finished, question and all: its claim ended
          // there too (Presence.finish), and the rules never pick up a card in that lane.
          if (card && state === "asking" && card.done) ready.push(`[${id}] was moved to the done lane with its question still open: the owner finished it, so stop waiting on it.`);
          else if (state === "asking") waiting.push(id);
          else if (!card) ready.push(`[${id}] is gone: the owner deleted it, so stop working on it.`);
          else if (state === "answered") ready.push(`ANSWERED. Call claim_card on it (that renews your claim, or takes it back if it lapsed) and act on the answer:\n${card.text}`);
          else ready.push(`[${id}] has no open question and no answer. Call get_card to see where it stands.`);
        }
        if (ready.length) {
          const rest = waiting.length ? `\n\nStill waiting on the owner: ${waiting.map((id) => `[${id}]`).join(", ")}` : "";
          return text(ready.join("\n\n") + rest);
        }
        if (Date.now() + every > until || req.signal.aborted) {
          // Once more on the way out, so a 30-second hold reads as heard from at both ends.
          await here();
          return text(`Nothing is answered yet on ${waiting.map((id) => `[${id}]`).join(", ")}. Call wait_for_answer again to keep waiting.`);
        }
        await sleep(every);
      }
    });

    server.registerTool("claim_card", {
      title: "Claim card",
      description: doc("claim_card"),
      inputSchema: z.object({
        id: z.string().describe("Card id like c1a2b"),
        session_id: z.string().min(6).max(80).regex(/^[\w.:-]+$/).describe("Your session id: the one get_started gave you, the same on every call"),
        agent: z.string().max(40).optional().describe("What you are, like claude-code, codex, or cursor"),
        machine: z.string().max(60).optional().describe("The hostname of the machine you run on"),
        project: z.string().max(80).optional().describe("The name of the folder you're working in, not the whole path"),
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
      // Not an error: a claim ends by itself when its card reaches the done lane or is deleted
      // (Presence.finish), so an agent that moves a card to Done and then releases lands here.
      return text(released ? `Released [${input.id}].`
        : `Session ${input.session_id} holds no claim on [${input.id}], so there's nothing to release. A claim ends by itself when its card reaches the done lane or is deleted.`);
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
        const r = (await agent.runTool(name, input, undefined, "agent", user.email)) as ToolOutcome;
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
