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
import { doneLaneId } from "./lanes";
import { AGENT_TAG, forAgent, GAUNTLET_TAG, hasTag, memberTouch, NEEDS_CEO_TAG, type Board, type Card, type MemberTouch } from "./shared";

// The tags live in shared.ts, where the app can reach them too.
export { AGENT_TAG, GAUNTLET_TAG, NEEDS_CEO_TAG };
/** The subprotocol a client offers alongside its token, and the one the server picks. */
export const EVENTS_PROTOCOL = "tasks-events";

/**
 * `member` is there when a member put something on the card (memberTouch in shared.ts): `text`
 * when they wrote its title or notes, `tags` when they last changed its tags, `files` for each
 * file they attached, each with their email and when. Those parts aren't the owner's, whoever
 * made the change this line reports.
 */
type CardRef = { id: string; title: string; lane: string; tags: string[]; member?: MemberTouch };
/**
 * Who made the change an event reports. `role` is always "owner" on the feed: a member's
 * change never publishes (agentEvents). `via` is "app" for a change made by hand and
 * "assistant" for the in-app assistant acting on the owner's message. It's stamped by the
 * board from the connection that made the change, the same as the mark on a card.
 */
export type EventBy = { email: string; role: "owner" | "member"; via: "app" | "assistant" };
export type TaskEvent =
  | ({ type: "added" | "tagged" | "edited" | "moved" | "deleted"; by: EventBy } & CardRef)
  // `answer` and `question` are there when the card had a question (ask_ceo) and you answered it with a tap.
  | ({ type: "answered"; answer?: string; question?: string; by: EventBy } & CardRef)
  | { type: "hello"; cards: CardRef[] };

const ref = (b: Board, c: Card): CardRef => {
  const member = memberTouch(c);
  return { id: c.id, title: c.title, lane: b.lanes.find((l) => l.id === c.laneId)?.name ?? c.laneId, tags: c.tags ?? [], ...(member ? { member } : {}) };
};

/**
 * What changed on #agent and #gauntlet cards between two boards, one event per card. "answered" means
 * #needs-ceo came off, which is how you tell the agent you've replied.
 *
 * Every event says who made the change (`by`). Only the owner's changes are events. A member
 * can't touch an agent's card or its tags in the first place (the write guard, member-rules.ts);
 * if one ever did, it still must not reach an agent as "added" or "answered", because the
 * agent would act on it with the owner's privileges. So a member's change publishes nothing.
 */
export function agentEvents(before: Board, after: Board, by: EventBy): TaskEvent[] {
  if (after.sealed || by.role !== "owner") return [];
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
      out.push({ type, ...ref(after, c), answer: c.answer.answer, question: c.answer.question, by });
    } else if (type) out.push({ type, ...ref(after, c), by } as TaskEvent);
  }
  const kept = new Set(after.cards.map((c) => c.id));
  for (const p of before.cards) if (forAgent(p) && !kept.has(p.id)) out.push({ type: "deleted", ...ref(before, p), by });
  return out;
}

/** Every open #agent or #gauntlet card (anything not in the done lane), sent first on each connect so nothing is missed while offline. */
export function agentQueue(b: Board): TaskEvent {
  const done = doneLaneId(b.lanes);
  return { type: "hello", cards: b.cards.filter((c) => forAgent(c) && c.laneId !== done).map((c) => ref(b, c)) };
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
