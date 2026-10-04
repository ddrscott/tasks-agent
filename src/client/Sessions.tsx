// The // SESSIONS panel: every Claude Code session reporting in (src/presence.ts), grouped by
// project, the ones waiting on you first. Its button counts live sessions and nothing else: the
// sessions stopped at a prompt are counted on "need you" (Ask.tsx), with the open questions. The list arrives over its own WebSocket, apart from
// the board's, and "stale" is worked out here from how long a session has been quiet.

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { blockedSessions, isStale, known, projectName, waitingFor, whoWhere, type Claim, type PresenceView, type Session } from "../presence-shared";
import { BASE } from "./base";
import { Popover } from "./Board";
import { IconSessions } from "./icons";

export type Presence = {
  sessions: Session[];
  claims: Claim[];
  /** The server's clock, moved along locally, so "seen 20s ago" doesn't depend on this machine's. */
  now: number;
};

const EMPTY: Presence = { sessions: [], claims: [], now: Date.now() };
const TICK_MS = 10_000;
const PING_MS = 30_000;

/** The live list of sessions and claims. Off (and empty) on an encrypted board, which keeps none. */
export function usePresence(enabled: boolean): Presence {
  const [view, setView] = useState<PresenceView | null>(null);
  const skew = useRef(0);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!enabled) { setView(null); return; }
    let ws: WebSocket | null = null;
    let closed = false;
    let backoff = 1000;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${BASE}/presence`);
      ws.onopen = () => { backoff = 1000; ping = setInterval(() => ws?.send("ping"), PING_MS); };
      ws.onmessage = (m) => {
        if (m.data === "pong") return;
        try {
          const v = JSON.parse(String(m.data)) as PresenceView;
          skew.current = v.now - Date.now();
          setView(v);
        } catch { /* not ours */ }
      };
      ws.onclose = () => {
        clearInterval(ping);
        if (closed) return;
        retry = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      };
    };
    connect();
    return () => { closed = true; clearTimeout(retry); clearInterval(ping); ws?.close(); };
  }, [enabled]);

  // Time passing changes what's stale, with no message to say so.
  useEffect(() => {
    if (!view?.sessions.length) return;
    const t = setInterval(() => tick((n) => n + 1), TICK_MS);
    return () => clearInterval(t);
  }, [!!view?.sessions.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!view) return EMPTY;
  return { sessions: view.sessions, claims: view.claims, now: Date.now() + skew.current };
}

/** So a card can show who holds it without the list being threaded through every lane. */
export const PresenceContext = createContext<Presence>(EMPTY);

/** The line on a card a session has claimed: its state, who and where, and when it was last heard from. */
export function CardPresence({ cardId }: { cardId: string }) {
  const { sessions, claims, now } = useContext(PresenceContext);
  const claim = claims.find((c) => c.cardId === cardId);
  const session = claim && sessions.find((s) => s.id === claim.sessionId);
  if (!claim || !session) return null;
  return <PresenceLine session={session} agent={claim.agent} now={now} />;
}

/**
 * A session in one line. Under a claimed card's title, and under a question its session is
 * waiting on. The name is the session's own, the same one its Sessions row shows; the claim's is
 * only for a session that never said. Under a question (`askedAt`) the line also names the
 * project and says how long the question has been open, in place of when it was last heard from.
 */
export function PresenceLine({ session, agent, now, askedAt }: { session: Session; agent?: string; now: number; askedAt?: string }) {
  const who = whoWhere(session, session.agent || agent);
  return (
    <div className="card-presence" title={`${session.last || "claimed"} · session ${session.id}`}>
      <StateMark session={session} now={now} />
      <span className="sess-where">{askedAt && known(session.project) ? `${who} · ${session.project}` : who}</span>
      <span className="sess-seen">{askedAt ? waitingFor(now - Date.parse(askedAt)) : ago(now - session.seenAt)}</span>
    </div>
  );
}

/** In the card editor: the whole Sessions row for the session holding this card, resume command included. */
export function CardSession({ cardId }: { cardId: string }) {
  const { sessions, claims, now } = useContext(PresenceContext);
  const claim = claims.find((c) => c.cardId === cardId);
  const session = claim && sessions.find((s) => s.id === claim.sessionId);
  if (!claim || !session) return null;
  return (
    <ul className="card-session" aria-label="The session working on this card">
      <SessionRow session={claim.agent && !session.agent ? { ...session, agent: claim.agent } : session} now={now} cards={[]} />
    </ul>
  );
}

// The rules for what's stale and what's waiting on you live with the shared shapes, so
// `npm run check:presence` can run them without a browser.
export { blockedSessions, isStale };

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

const STATE_LABEL: Record<Session["state"], string> = { "needs-input": "needs input", working: "working", idle: "idle" };
const RANK: Record<Session["state"], number> = { "needs-input": 0, working: 1, idle: 2 };
/** Waiting on you first, then working, then idle; stale ones sink; newest first within each. */
const order = (now: number) => (a: Session, b: Session) =>
  Number(isStale(a, now)) - Number(isStale(b, now)) || RANK[a.state] - RANK[b.state] || b.seenAt - a.seenAt;

/** One session's state, as the orange $ and a word. Shared with the line on a claimed card. */
export function StateMark({ session, now }: { session: Session; now: number }) {
  const stale = isStale(session, now);
  return (
    <span className={`sess-state is-${stale ? "stale" : session.state}`}>
      <span className="sess-mark" aria-hidden="true">{stale ? "·" : "$"}</span>
      {stale ? "stale" : STATE_LABEL[session.state]}
    </span>
  );
}

function ResumeButton({ session }: { session: Session }) {
  const [done, setDone] = useState(false);
  const cmd = `${session.cwd ? `cd ${/[^\w@%+=:,./-]/.test(session.cwd) ? `'${session.cwd.replace(/'/g, `'\\''`)}'` : session.cwd} && ` : ""}claude --resume ${session.id}`;
  return (
    <button
      className="sess-resume" title={`Copy: ${cmd}`}
      onClick={() => void navigator.clipboard.writeText(cmd).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}
    >{done ? "Copied" : "Copy resume command"}</button>
  );
}

/** One session as a list row. The Sessions list, the card editor, and the "need you" list all draw it. */
export function SessionRow({ session, now, cards }: { session: Session; now: number; cards: string[] }) {
  return (
    <li className={`sess-row${isStale(session, now) ? " stale" : ""}`}>
      <div className="sess-line">
        <StateMark session={session} now={now} />
        <span className="sess-where">{whoWhere(session)}</span>
        <span className="sess-seen" title={new Date(session.seenAt).toLocaleString()}>{ago(now - session.seenAt)}</span>
      </div>
      {session.last && <div className="sess-last">{session.last}</div>}
      {/* "claimed "Fix login"" already names the card, so it isn't said twice. */}
      {cards.filter((t) => !session.last.includes(`"${t}"`)).map((t) => <div key={t} className="sess-card">card: {t}</div>)}
      <div className="sess-links">
        {/* No folder means it never reported through hooks (it only claims cards), so there's nothing to resume. */}
        {session.link
          ? <a href={session.link} target="_blank" rel="noopener noreferrer">open session</a>
          : session.cwd && <ResumeButton session={session} />}
        <span className="sess-id" title={session.id}>{session.id.slice(0, 8)}</span>
      </div>
    </li>
  );
}

type Props = {
  presence: Presence; cardTitle(id: string): string | null; open: boolean; setOpen(o: boolean): void;
  /** Open the Connect page, at one of its sections when given a hash like "#sessions". */
  onConnect(hash?: string): void;
};

export function SessionsButton({ presence, cardTitle, open, setOpen, onConnect }: Props) {
  // Real links, so they can be opened in a new tab; a plain click stays in the app.
  const connectLink = (hash: string, label: string) => (
    <a
      href={`${BASE}/connect${hash}`}
      onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); setOpen(false); onConnect(hash); }}
    >{label}</a>
  );
  const { sessions, claims, now } = presence;
  const live = sessions.filter((s) => !isStale(s, now));
  // What's waiting on you is counted once, on "need you" next door. This button only says how many are live.
  const summary = `${live.length} live session${live.length === 1 ? "" : "s"}`;
  const groups = useMemo(() => {
    const by = new Map<string, Session[]>();
    for (const s of [...sessions].sort(order(now))) by.set(projectName(s), [...(by.get(projectName(s)) ?? []), s]);
    // A project's place comes from its most urgent session.
    return [...by.entries()].sort((a, b) => order(now)(a[1][0], b[1][0]));
  }, [sessions, now]);

  return (
    <div className="anchor">
      <button
        className="btn sess-btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}
        // The label can be down to a bare count when the bar is tight, so the name is spelled out.
        title={summary} aria-label={`Sessions: ${summary}`}
      >
        <IconSessions /><span className="hide-sm label">Sessions</span>
        {sessions.length > 0 && <span className="sess-count">{live.length}</span>}
      </button>
      {open && (
        <Popover label="Sessions" onClose={() => setOpen(false)}>
          <div className="sessions">
            <h2 className="h">SESSIONS</h2>
            {groups.length === 0 && (
              <p className="sess-empty">
                No sessions are reporting in. A Claude Code session reports through hooks you add once
                on each machine: {connectLink("#sessions", "set up the hooks")} and it shows up here
                within seconds. Any other agent shows up when it claims a card.
              </p>
            )}
            {groups.map(([project, list]) => (
              <section key={project}>
                <h3 className="sess-project">{project}<span>{list.length}</span></h3>
                <ul>
                  {list.map((s) => (
                    <SessionRow
                      key={s.id} session={s} now={now}
                      cards={claims.filter((c) => c.sessionId === s.id).map((c) => cardTitle(c.cardId)).filter((t): t is string => !!t)}
                    />
                  ))}
                </ul>
              </section>
            ))}
            {/* The way to the Connect page from here, so setup isn't only in the account menu. */}
            <p className="sess-foot">
              {connectLink("", "Connect an agent")}
              {groups.length > 0 && <> · {connectLink("#sessions", "Add another machine")}</>}
            </p>
          </div>
        </Popover>
      )}
    </div>
  );
}
