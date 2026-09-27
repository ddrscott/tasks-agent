// Routing bench: the production GLM path vs. a Jev fast path, on simulated boards.
// Run with `npm run bench` (bench/run.mjs drives this Worker over localhost).
//
//   POST /glm {id}      the real system prompt and board tools, applied to a copy of the board
//   POST /jev {id, k}   embed the message, shortlist k cards, one Jev call
//   GET  /cases         the labeled cases, for the driver

import { generateText, isStepCount, tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import { systemPrompt } from "../src/prompt";
import * as ops from "../src/shared";
import type { Board } from "../src/shared";
import { BOARD_TOOLS, TOOL_NAMES, type ToolName } from "../src/tools";
import { BOARDS, CASES, LANE_NOTES, TODAY, type Case, type Op } from "./cases";

type Env = { AI: Ai; CHAT_MODEL?: string; JEV_GATEWAY?: string; BENCH_KEY?: string };

const CHAT_MODEL = "@cf/zai-org/glm-4.7-flash";
const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

/** What an arm decided, in the same shape as the gold label. */
type Pred = { op: Op; cards: string[]; lane?: string };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // Deployed, the bench answers only to bench/.bench-key, and to nobody until that secret is set.
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (!local && (!env.BENCH_KEY || req.headers.get("x-bench-key") !== env.BENCH_KEY)) return new Response("forbidden", { status: 403 });
    if (req.method === "GET" && url.pathname === "/cases") return Response.json(CASES);
    const body = (await req.json().catch(() => ({}))) as { id?: string; k?: number };
    const c = CASES.find((x) => x.id === body.id);
    if (!c) return Response.json({ error: "unknown case" }, { status: 404 });
    try {
      if (url.pathname === "/glm") return Response.json(await runGlm(env, c));
      if (url.pathname === "/jev") return Response.json(await runJev(env, c, body.k ?? 8));
      return Response.json({ error: "not found" }, { status: 404 });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  },
};

// ---------- GLM: exactly what the chat does today, minus streaming ----------

async function runGlm(env: Env, c: Case) {
  let board = structuredClone(BOARDS[c.board]);
  const calls: { name: string; input: unknown }[] = [];
  const t0 = Date.now();
  let firstChange: number | null = null;

  const boardTools = Object.fromEntries(TOOL_NAMES.map((name: ToolName) => {
    const { description, inputSchema, apply } = BOARD_TOOLS[name];
    return [name, tool({
      description,
      inputSchema,
      execute: async (input: unknown) => {
        calls.push({ name, input });
        try {
          const r = (apply as (b: Board, i: unknown) => { board: Board; summary: string })(board, input);
          board = r.board;
          firstChange ??= Date.now() - t0;
          return { ok: true, summary: r.summary, board: ops.describeBoard(board) };
        } catch (e) {
          return { ok: false, summary: (e as Error).message };
        }
      },
    })];
  }));

  const workersai = createWorkersAI({ binding: env.AI });
  const result = await generateText({
    model: workersai((env.CHAT_MODEL ?? CHAT_MODEL) as Parameters<typeof workersai>[0]),
    system: systemPrompt(board, TODAY),
    messages: [{ role: "user", content: c.msg }],
    stopWhen: isStepCount(8),
    tools: {
      ...boardTools,
      // The real one searches the agent's index; a substring match is enough on boards this small.
      search_cards: tool({
        description: "Search cards by keywords and by meaning across titles and notes.",
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => {
          calls.push({ name: "search_cards", input: { query } });
          const words = query.toLowerCase().split(/\W+/).filter((w: string) => w.length > 2);
          const hits = board.cards.filter((card) => words.some((w) => `${card.title} ${card.notes}`.toLowerCase().includes(w)));
          return { ok: true, results: hits.map((h) => `- [${h.id}] ${h.title} (${ops.findLane(board, h.laneId)?.name})`).join("\n") || "No matching cards." };
        },
      }),
    },
  });

  return {
    pred: predFromCalls(calls, BOARDS[c.board]),
    calls,
    reply: result.text,
    msFirstChange: firstChange,
    msTotal: Date.now() - t0,
    usage: { input: result.totalUsage?.inputTokens ?? 0, output: result.totalUsage?.outputTokens ?? 0 },
  };
}

/** Collapse GLM's tool calls into one decision, so it scores on the same terms as Jev. */
function predFromCalls(calls: { name: string; input: unknown }[], before: Board): Pred {
  const changes = calls.filter((x) => x.name !== "search_cards");
  if (!changes.length) return { op: "none", cards: [] };
  const kind = (n: string): Op =>
    n === "move_cards" ? "move" : n === "add_cards" ? "create" : n === "update_card" ? "edit" : n === "delete_cards" ? "delete" : "mixed";
  const kinds = new Set(changes.map((x) => kind(x.name)));
  const cards = new Set<string>();
  const lanes = new Set<string>();
  for (const x of changes) {
    const i = x.input as { ids?: string[]; id?: string; lane?: string };
    for (const id of i.ids ?? (i.id ? [i.id] : [])) cards.add(id);
    if (x.name === "move_cards" && i.lane) lanes.add(ops.findLane(before, i.lane)?.id ?? i.lane);
  }
  if (kinds.size > 1 || lanes.size > 1) return { op: "mixed", cards: [...cards] };
  const [op] = kinds;
  return { op, cards: [...cards].sort(), lane: [...lanes][0] };
}

// ---------- Jev: shortlist by embedding, then one typed classification ----------

// Card vectors per board. Production keeps these in `card_vec`, so only the query embedding is timed.
const cardVecs = new Map<string, Map<string, number[]>>();

async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const out = (await env.AI.run(EMBEDDING_MODEL as never, { text: texts } as never)) as unknown as { data: number[][] };
  return out.data;
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / Math.sqrt(na * nb);
};

async function runJev(env: Env, c: Case, k: number) {
  const b = BOARDS[c.board];
  if (!cardVecs.has(c.board)) {
    const vecs = await embed(env, b.cards.map((x) => `${x.title}\n${x.notes}`));
    cardVecs.set(c.board, new Map(b.cards.map((x, i) => [x.id, vecs[i]])));
  }
  const t0 = Date.now();
  const [qv] = await embed(env, [c.msg]);
  const msEmbed = Date.now() - t0;
  const vecs = cardVecs.get(c.board)!;
  const shortlist = b.cards
    .map((x) => ({ card: x, score: cosine(qv, vecs.get(x.id)!) }))
    .sort((x, y) => y.score - x.score)
    .slice(0, k)
    .map((x) => x.card);

  const laneName = (id: string) => b.lanes.find((l) => l.id === id)?.name ?? id;
  const state = {
    today: TODAY,
    message: c.msg,
    lanes: b.lanes.map((l, i) => ({
      id: l.id, name: l.name,
      position: i === 0 ? "first (new, not started)" : i === b.lanes.length - 1 ? "last (finished)" : "middle",
      meaning: LANE_NOTES[c.board]?.[l.id],
    })),
    cards: shortlist.map((x) => ({ id: x.id, title: x.title, lane: laneName(x.laneId), due: x.due, notes: x.notes || undefined })),
  };

  const laneLine = (l: { id: string; name: string }) => {
    const note = LANE_NOTES[c.board]?.[l.id];
    return note ? `${l.name}: ${note}` : l.name;
  };
  const questions: Record<string, unknown> = {
    op: {
      type: "choice",
      instructions: "The message was typed into the chat of a kanban task board. What does the user want done?",
      criteria: {
        move: "Change the status of existing cards: finished, started, reopened, sent for review, or moved to a named lane. Every card goes to the same lane.",
        create: "Add new cards that aren't on the board yet",
        edit: "Change the title, notes, or due date of existing cards without moving them",
        delete: "Remove existing cards from the board entirely",
        none: "A question about the board, or conversation; nothing on the board should change",
        mixed: "More than one kind of change in one message, or cards going to different lanes",
        unclear: "It's about existing cards, but two or more cards fit the message about equally well and it doesn't say which one",
      },
    },
    lane: {
      type: "choice",
      instructions: "If cards are being moved, which lane should they end up in? Pick the lane whose meaning matches the new status the message describes.",
      criteria: { ...Object.fromEntries(b.lanes.map((l) => [l.id, laneLine(l)])), none: "No cards are being moved" },
    },
    scope: {
      type: "choice",
      instructions: "Does the message pick out cards one by one, or mean every card in a lane?",
      criteria: {
        named: "It names or describes particular cards",
        whole_lane: "It means every card in a lane, like \"everything in doing\" or \"all the review cards\"",
      },
    },
    from_lane: {
      type: "choice",
      instructions: "If the message means every card in a lane, which lane are those cards in now?",
      criteria: { ...Object.fromEntries(b.lanes.map((l) => [l.id, l.name])), none: "The message doesn't mean a whole lane" },
    },
    ...Object.fromEntries(shortlist.map((x) => [`rel_${x.id}`, {
      type: "noul",
      instructions: `Is the card "${x.title}" (id ${x.id}) one of the cards the user's message is about?`,
      criteria: { true: "The message refers to this card, possibly in different words or through its notes", false: "The message is about something else" },
    }])),
  };

  const t1 = Date.now();
  const opts = env.JEV_GATEWAY ? { gateway: { id: env.JEV_GATEWAY } } : undefined;
  // Through Unified Billing the answers arrive wrapped: { state: "Completed", result: {...} }.
  const res = (await env.AI.run("typesafe/jev" as never, { state, questions } as never, opts as never)) as JevResponse & { result?: JevResponse };
  const out = res.result ?? res;
  const msJev = Date.now() - t1;

  const a = out.answers ?? {};
  const op = readChoice(a.op);
  const lane = readChoice(a.lane);
  const rel = Object.fromEntries(shortlist.map((x) => [x.id, readNoul(a[`rel_${x.id}`])]));
  // "Everything in doing" can't be answered card by card: take the whole lane from the full board.
  const scope = readChoice(a.scope);
  const fromLane = readChoice(a.from_lane);
  const wholeLane = scope.choice === "whole_lane" && fromLane.choice !== "none";
  const cards = wholeLane
    ? b.cards.filter((x) => x.laneId === fromLane.choice).map((x) => x.id).sort()
    : Object.entries(rel).filter(([, p]) => p >= 0.5).map(([id]) => id).sort();
  const opName = (op.choice === "unclear" ? "ask" : op.choice) as Op;

  return {
    pred: { op: opName, cards, lane: lane.choice === "none" ? undefined : lane.choice } satisfies Pred,
    conf: { op: op.confidence, lane: lane.confidence, scope: scope.confidence, rel },
    shortlist: shortlist.map((x) => x.id),
    msEmbed,
    msJev,
    usage: { input: out.usage?.input_tokens ?? out.usage?.prompt_tokens ?? 0 },
    model: out.model,
    raw: out.answers,
  };
}

type JevResponse = {
  answers?: Record<string, unknown>;
  usage?: { input_tokens?: number; prompt_tokens?: number };
  model?: string;
};

// The docs describe these shapes loosely, so read them defensively.
function readChoice(x: unknown): { choice: string; confidence: number } {
  const v = x as { choice?: string; confidence?: number; probabilities?: Record<string, number> } | undefined;
  if (!v) return { choice: "none", confidence: 0 };
  const choice = v.choice ?? Object.entries(v.probabilities ?? {}).sort((p, q) => q[1] - p[1])[0]?.[0] ?? "none";
  return { choice, confidence: v.confidence ?? v.probabilities?.[choice] ?? 0 };
}

function readNoul(x: unknown): number {
  if (typeof x === "number") return x;
  const v = x as { noul?: number; probability?: number; value?: number } | undefined;
  return v?.noul ?? v?.probability ?? v?.value ?? 0;
}
