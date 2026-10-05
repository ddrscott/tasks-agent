// What the app needs to know when the board on screen is someone else's (// TEAM_BOARDS in the
// README). Everything here is driven by what the server said: the answer from
// `GET /api/board/access`, then the `tasks_access` frames on the board's socket. Nothing here
// decides a role; it only turns the server's answer into what to show and what to say.

import { createContext, useContext } from "react";
import { isAgentCard, ownerTagInTitle, ownerTagLike, type ActivityFrame } from "../member-rules";
import { memberTouch, type By, type Card, type MemberTouch } from "../shared";

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
  writer: "You can add, edit, move, and delete cards and attach files. Lanes, undo, the owner's agent cards, and board settings stay with the owner.",
} as const;

/** The line under the top bar of a shared board: whose it is, what you can do, and what would change that. */
export function bannerText(a: MemberAccess): { lead: string; rest: string } {
  const o = a.ownerEmail;
  if (a.role === "writer" && a.reason === "plan_lapsed") {
    return { lead: `${o}'s board is view only for now.`, rest: "Their Pro plan lapsed. Nothing was deleted, and you can change cards again when the plan is back." };
  }
  if (a.effective === "writer") {
    return { lead: `You're a writer on ${o}'s board.`, rest: "You can change cards. Lanes, undo, questions, agent cards, and board settings are the owner's." };
  }
  // A viewer while the owner's plan is lapsed: being made a writer wouldn't help, so don't send them to ask for it.
  if (a.reason === "plan_lapsed") {
    return { lead: `You're viewing ${o}'s board. View only.`, rest: "Their Pro plan lapsed, so nobody but them can change cards until it's back. Nothing was deleted." };
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

/**
 * Why the lines of a pasted list that didn't become cards were left, for the note under the
 * box. One reason reads as one sentence. Lines held back for different reasons each get
 * theirs, with the line it's about, one to a row: "5 added, 2 left" used to explain only the
 * first. `untried` is how many lines after a stopped piece were never sent.
 */
export function leftReasons(reasons: Map<string, string[]>, untried = 0): string {
  const rest = untried > 0 ? `${untried} more ${untried === 1 ? "line wasn't" : "lines weren't"} tried. Add again once the ${reasons.size > 1 ? "others are" : "rest is"} sorted out.` : "";
  if (reasons.size === 1 && !rest) return [...reasons.keys()][0];
  const short = (line: string) => (line.length > 40 ? `${line.slice(0, 40)}…` : line);
  const rows = [...reasons].map(([reason, lines]) => `“${short(lines[0])}”${lines.length > 1 ? ` and ${lines.length - 1} more` : ""}: ${reason}`);
  return [reasons.size > 1 ? "They were left for different reasons." : "", ...rows, rest].filter(Boolean).join("\n");
}

/** Why the server turned a writer's change down, when the app can say it before they try. */
export const ASK_HOLDS = (owner: string) => `This card has a question waiting on ${owner}. It can't be finished or deleted until they answer.`;

// ── The owner's agents' cards and tags (OWNER_TAGS in member-rules.ts) ─────────────────────

/** A card a writer can read and not change: it's a work order for the owner's agents. */
export const agentHeld = (mode: Mode | undefined, card: Card) => mode === "writer" && isAgentCard(card);
/** Said on such a card, in the open card. */
export const AGENT_HOLDS = (owner: string) =>
  `This card is a work order for ${owner}'s agents (it's tagged #agent or #gauntlet), so only ${owner} can change, move, or delete it.`;
/** Said when a member's tags would add or remove one of the owner's. */
export const OWNER_TAG_NOTE = (tag: string, owner: string, typed?: string) =>
  `${typed && typed !== tag ? `#${typed} reads as #${tag}. ` : ""}Only ${owner} can put #${tag} on a card or take it off. Their agents take orders from that tag.`;
/**
 * The owner tag a member's edit would add or remove, or that their title ends in, if any. The
 * server refuses the same thing (memberChangeError); this is so the dialog can say it before
 * anything is sent, with the field still open to fix.
 */
export function ownerTagTouched(before: string[], after: string[], title?: string): string | null {
  // An added tag counts when it only reads as the owner's (`ship_ok`, a Cyrillic \u0430 in `agent`); a removed one has to be the real thing.
  const added = after.filter((t) => !before.includes(t)).map(ownerTagLike).find(Boolean);
  const removed = before.filter((t) => !after.includes(t)).find((t) => ownerTagLike(t) === t);
  return added ?? removed ?? (title !== undefined ? ownerTagInTitle(title) : null);
}

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

/** A `tasks_activity` frame off the socket, or null when it isn't one. */
export function asActivity(f: unknown): ActivityFrame | null {
  const v = f as Partial<ActivityFrame> | null;
  if (!v || v.type !== "tasks_activity" || (v.action !== "card_deleted" && v.action !== "card_restored")) return null;
  if (!v.by || typeof v.by.email !== "string" || !Array.isArray(v.cards) || typeof v.count !== "number") return null;
  return v as ActivityFrame;
}

/**
 * What to say when somebody else deletes a card on a shared board, or brings one back:
 * `dana@example.com deleted "Ship the invoice"`. Null for your own doing, which the tab that
 * did it already said. The one exception is your own agent over MCP: no tab did that, so the
 * owner hears "Your agent deleted …". `count` and `first` let a run of them read as one line.
 */
export function activityText(f: ActivityFrame, me: string, run?: { count: number; first: string }): string | null {
  const first = run?.first ?? f.cards[0]?.title;
  const count = run?.count ?? f.count;
  const mine = f.by.email === me;
  if ((mine && f.by.via !== "agent") || typeof first !== "string") return null;
  const who = mine ? "Your agent" : f.by.email;
  const how = mine ? "" : f.by.via === "agent" ? " via MCP" : f.by.via === "assistant" ? " via the assistant" : f.by.via === "undo" ? ", with Undo," : f.by.via === "redo" ? ", with Redo," : "";
  const title = first.length > 60 ? `${first.slice(0, 60)}…` : first;
  const what = count > 1 ? `${count} cards: "${title}" and ${count - 1} more` : `"${title}"`;
  return `${who}${how} ${f.action === "card_deleted" ? "deleted" : "brought back"} ${what}`;
}

/**
 * Deletions that came one after another from the same person, shown as one toast. `steps` are
 * the undo steps that reverse them, oldest first, on the owner's board (a member has none).
 */
export type ActivityRun = { key: string; count: number; first: string; steps: number[]; toast: number };

/**
 * Fold a new frame into the run on screen, or start a new one. It joins only when it's the
 * same person doing the same thing, the run's toast is still the one showing, and, for the
 * owner, its undo step is the very next one (or the same one: two cards in one step). A step
 * that isn't next means something else changed the board in between, and then one Undo
 * couldn't honestly cover both, so that frame gets a toast of its own.
 */
export function joinRun(prev: ActivityRun | null, f: ActivityFrame, showing: number | null, toast: number, canUndo: boolean): ActivityRun {
  const key = `${f.action}|${f.by.email}|${f.by.via ?? ""}`;
  const step = canUndo && f.action === "card_deleted" && typeof f.undo === "number" ? f.undo : null;
  const fresh: ActivityRun = { key, count: f.count, first: f.cards[0]?.title ?? "", steps: step === null ? [] : [step], toast };
  if (!prev || prev.key !== key || showing !== prev.toast) return fresh;
  const last = prev.steps[prev.steps.length - 1];
  if (canUndo && f.action === "card_deleted") {
    if (step === null || last === undefined || (step !== last && step !== last + 1)) return fresh;
    return { ...prev, count: prev.count + f.count, steps: step === last ? prev.steps : [...prev.steps, step], toast };
  }
  return { ...prev, count: prev.count + f.count, toast };
}

const verb = (c: Card) => (c.createdAt === c.updatedAt ? "Added" : "Edited");

/** In the open card: "Edited by dana@example.com · 3m ago". Nothing on a board that isn't shared, or a card from before names were kept. `marks` adds what a member wrote on it (WroteLine); the owner's editor says that in its own block (MemberWords). */
export function ByLine({ card, marks = true }: { card: Card; marks?: boolean }) {
  const who = useContext(WhoContext);
  if (!who || !card.by) return null;
  return (
    <div className="by-line" title={new Date(card.updatedAt).toLocaleString()}>
      {verb(card)} by <b>{whoText(card.by, who.me)}</b> · {ago(card.updatedAt, who.now)}
      {marks && <WroteLine card={card} />}
    </div>
  );
}

/**
 * What a member put on a card that the card's last line doesn't already say: their title or
 * notes, their tags (`member` on the card), their files (`by` on each file). A part is left
 * out when that same member made the last change by hand, since "Edited by dana@…" says it.
 * `me` leaves out the viewer's own parts, for the card's face.
 */
function touched(card: Card, me?: string): MemberTouch | null {
  const t = memberTouch(card);
  if (!t) return null;
  const last = card.by && !card.by.via ? card.by.email : null;
  const keep = (email: string) => email !== last && email !== me;
  const text = t.text && keep(t.text.email) ? t.text : undefined;
  const tags = t.tags && keep(t.tags.email) ? t.tags : undefined;
  const files = (t.files ?? []).filter((f) => keep(f.email));
  return text || tags || files.length ? { ...(text ? { text } : {}), ...(tags ? { tags } : {}), ...(files.length ? { files } : {}) } : null;
}
function WroteLine({ card }: { card: Card }) {
  const who = useContext(WhoContext);
  const t = touched(card);
  if (!who || !t) return null;
  const name = (email: string) => (email === who.me ? "you" : email);
  return (
    <>
      {t.text && <span className="by-wrote" title={new Date(t.text.at).toLocaleString()}>Title or notes written by <b>{name(t.text.email)}</b>, a member · {ago(t.text.at, who.now)}</span>}
      {t.tags && <span className="by-wrote" title={new Date(t.tags.at).toLocaleString()}>Tags set by <b>{name(t.tags.email)}</b>, a member · {ago(t.tags.at, who.now)}</span>}
    </>
  );
}

/**
 * In the owner's card editor: what a member wrote on this card, what that mark does, and the
 * button that takes it off. The mark never comes off because of an edit, however complete, so
 * this is where the owner says "I've read these and they're mine". Files are marked on their
 * own rows and stay marked while they're on the card.
 */
export function MemberWords({ card, onClaim }: { card: Card; onClaim?(): void }) {
  const who = useContext(WhoContext);
  const t = memberTouch(card);
  if (!t || (!t.text && !t.tags)) return null;
  const now = who?.now ?? Date.now();
  return (
    <div className="member-words" role="note" aria-label="A member wrote on this card">
      <p className="member-words-who">
        <span className="member-words-mark" aria-hidden="true">$</span>
        <span>
          {t.text && <span title={new Date(t.text.at).toLocaleString()}>Title or notes written by <b>{t.text.email}</b>, a member · {ago(t.text.at, now)}</span>}
          {t.tags && <span title={new Date(t.tags.at).toLocaleString()}>Tags set by <b>{t.tags.email}</b>, a member · {ago(t.tags.at, now)}</span>}
        </span>
      </p>
      <p className="member-words-why">
        Your agents are told these aren't your words and to ask you before acting on them. Editing the card doesn't change that. This button does.
        {t.files ? " Files a member attached stay marked for as long as they're on the card." : ""}
      </p>
      {onClaim && <div className="member-words-act"><button type="button" className="btn" onClick={onClaim}>These words are mine now</button></div>}
    </div>
  );
}

/** "words and tags by dana@…": what members put on a card, by person, for its face. */
function touchWords(t: MemberTouch): string {
  const by = new Map<string, string[]>();
  const add = (email: string, what: string) => { if (!by.get(email)?.includes(what)) by.set(email, [...(by.get(email) ?? []), what]); };
  if (t.text) add(t.text.email, "words");
  if (t.tags) add(t.tags.email, "tags");
  for (const f of t.files ?? []) add(f.email, (t.files ?? []).filter((x) => x.email === f.email).length > 1 ? "files" : "file");
  const list = (parts: string[]) => (parts.length < 3 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`);
  return [...by].map(([email, parts]) => `${list(parts)} by ${email}`).join(" · ");
}

/** On the card face, only when the last change wasn't yours by hand: that's the one worth a line. */
export function ByFace({ card }: { card: Card }) {
  const who = useContext(WhoContext);
  if (!who || !card.by) return null;
  // A member's words, tags, or files under someone else's last change: say whose they are, on the face, for everyone but that member.
  const t = touched(card, who.me);
  const said = t ? touchWords(t) : "";
  const words = said ? <span className="card-by-wrote">{said}</span> : null;
  const long = said ? `${said[0].toUpperCase()}${said.slice(1)}, not the board's owner` : "";
  if (card.by.email === who.me && !card.by.via) return words ? <div className="card-by" title={long}>{words}</div> : null;
  const text = whoText(card.by, who.me);
  return (
    <div className="card-by" title={`${verb(card)} by ${text}, ${new Date(card.updatedAt).toLocaleString()}${long ? `. ${long}` : ""}`}>
      <span className="card-by-who">{text}</span><span className="card-by-when">· {ago(card.updatedAt, who.now)}</span>{words}
    </div>
  );
}
