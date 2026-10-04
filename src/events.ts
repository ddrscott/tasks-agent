// A live feed of the changes you make to #agent and #gauntlet cards, for an agent session on your own
// machine (scripts/tasks-events.mjs, watched by Claude Code's Monitor). The agent dials
// out to /tasks/events with a personal access token, so nothing on your machine has to
// accept connections.
//
// One TaskEvents Durable Object per user holds the sockets. It's separate from TodoAgent
// on purpose: the Agents SDK treats every socket on TodoAgent as a board client, which
// gets the whole board synced to it and can call board actions. These sockets only ever
// receive event lines. TodoAgent publishes to it over RPC after a change you made; the
// agent's own MCP calls publish nothing, so an agent can't wake itself.

import { DurableObject } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { hasTag, NEEDS_CEO_TAG, type Board, type Card } from "./shared";

export const AGENT_TAG = "agent";
/** Cards for a gauntlet agent (~/.claude/agents/gauntlet.md). They ride the same feed without #agent, so a lead never takes one. */
export const GAUNTLET_TAG = "gauntlet";
const forAgent = (c: Card) => hasTag(c, AGENT_TAG) || hasTag(c, GAUNTLET_TAG);
export { NEEDS_CEO_TAG };
/** The subprotocol a client offers alongside its token, and the one the server picks. */
export const EVENTS_PROTOCOL = "tasks-events";

type CardRef = { id: string; title: string; lane: string; tags: string[] };
export type TaskEvent =
  | ({ type: "added" | "tagged" | "edited" | "moved" | "deleted" } & CardRef)
  // `answer` and `question` are there when the card had a question (ask_ceo) and you answered it with a tap.
  | ({ type: "answered"; answer?: string; question?: string } & CardRef)
  | { type: "hello"; cards: CardRef[] };

const ref = (b: Board, c: Card): CardRef => ({
  id: c.id, title: c.title, lane: b.lanes.find((l) => l.id === c.laneId)?.name ?? c.laneId, tags: c.tags ?? [],
});

/**
 * What changed on #agent and #gauntlet cards between two boards, one event per card. "answered" means
 * #needs-ceo came off, which is how you tell the agent you've replied.
 */
export function agentEvents(before: Board, after: Board): TaskEvent[] {
  if (after.sealed) return [];
  const was = new Map(before.cards.map((c) => [c.id, c]));
  const out: TaskEvent[] = [];
  for (const c of after.cards) {
    if (!forAgent(c)) continue;
    const p = was.get(c.id);
    let type: TaskEvent["type"] | null = null;
    if (!p) type = "added";
    else if (!forAgent(p)) type = "tagged";
    else if (hasTag(p, NEEDS_CEO_TAG) && !hasTag(c, NEEDS_CEO_TAG)) type = "answered";
    else if (p.laneId !== c.laneId) type = "moved";
    else if (p.title !== c.title || p.notes !== c.notes || p.due !== c.due || (p.tags ?? []).join() !== (c.tags ?? []).join()) type = "edited";
    if (type === "answered" && p?.ask && c.answer && c.answer.at !== p.answer?.at) {
      out.push({ type, ...ref(after, c), answer: c.answer.answer, question: c.answer.question });
    } else if (type) out.push({ type, ...ref(after, c) } as TaskEvent);
  }
  const kept = new Set(after.cards.map((c) => c.id));
  for (const p of before.cards) if (forAgent(p) && !kept.has(p.id)) out.push({ type: "deleted", ...ref(before, p) });
  return out;
}

/** Every open #agent or #gauntlet card (anything not in the done lane), sent first on each connect so nothing is missed while offline. */
export function agentQueue(b: Board): TaskEvent {
  const done = b.lanes[b.lanes.length - 1]?.id;
  return { type: "hello", cards: b.cards.filter((c) => forAgent(c) && (c.laneId !== done || b.lanes.length === 1)).map((c) => ref(b, c)) };
}

export class TaskEvents extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Clients ping to keep the connection alive; answering here doesn't wake the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** The Worker has already checked the token; `x-user` names whose board this is. */
  async fetch(req: Request): Promise<Response> {
    const user = req.headers.get("x-user");
    if (!user || req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const agent = await getAgentByName(this.env.TodoAgent, user);
    const hello = await agent.agentQueue();
    if (!hello) return new Response("This board is end-to-end encrypted, so it has no event feed.", { status: 409 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify(hello));
    const headers = new Headers();
    if (req.headers.get("Sec-WebSocket-Protocol")) headers.set("Sec-WebSocket-Protocol", EVENTS_PROTOCOL);
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  publish(events: TaskEvent[]) {
    for (const ws of this.ctx.getWebSockets()) {
      for (const e of events) {
        try { ws.send(JSON.stringify(e)); } catch { /* closing; the close handler cleans up */ }
      }
    }
  }

  // Event sockets are send-only. Anything but the auto-answered ping is ignored.
  webSocketMessage() {}

  webSocketClose(ws: WebSocket, code: number) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code); } catch { /* already closed */ }
  }
}
