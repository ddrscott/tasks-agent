import { useEffect, useRef, useState } from "react";
import type { GrantInfo } from "../oauth";
import type { TokenInfo } from "../tokens";
import { TOOL_LIST } from "../tool-docs";
import { feedCommand, fullPrompt, STARTER_LINE } from "../agent-rules";
// The script a machine needs, as text, so the page can hand it out. Someone using the
// hosted app has no checkout to copy it from, and this way it's always the build's own.
import eventsScript from "../../scripts/tasks-events.mjs?raw";
import { api, BASE } from "./base";
import { Footer } from "./Footer";
import { useTitle } from "./title";
import { IconCheck, IconTrash } from "./icons";

// Everything about working the board with outside agents, at /tasks/connect: the four-step
// quick start for Claude Code (QuickStart, which the empty board shows too), how to connect
// any other client over MCP, the prompt that starts it on the board, the apps already connected with OAuth,
// personal access tokens for clients that take a pasted token, the one command that installs
// the event feed, and how the #agent tag, questions, claims, and the event feed fit together.
//
// The page is public. Signed out, everything that explains is there; the parts that read or
// change an account (connected apps, tokens) become a "Sign in to create a token" link.

const PLACEHOLDER = "<YOUR_TOKEN>";

type Client = {
  id: string;
  name: string;
  steps: React.ReactNode[];
  code?: (url: string, token: string) => string;
  lang?: string;
  /** Which step the snippet belongs to, counting from 0. It's shown inside that step. */
  codeAt?: number;
};

/** Snippets that contain a token placeholder. */
const needsToken = (c: Client) => !!c.code && c.code("", PLACEHOLDER).includes(PLACEHOLDER);

const CLIENTS: Client[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    steps: [
      <>The <a href="#quick">quick start</a> above does all of this in one command, with a token. This is the OAuth way, which leaves no token on disk. Run this once in a terminal:</>,
      <>Start Claude Code, run <code>/mcp</code>, pick <b>tasks</b>, and choose <b>Authenticate</b>. Your browser opens here; sign in and <b>Allow</b>.</>,
      <>Add <code>#agent</code> to a card's title, or use its Tags field, and paste in the <a href="#prompt">starter prompt</a> below.</>,
    ],
    code: (url) => claudeMcpAdd(url),
    lang: "sh",
  },
  {
    id: "cursor",
    name: "Cursor",
    steps: [
      <>Add this to <code>~/.cursor/mcp.json</code> (or <code>.cursor/mcp.json</code> in a project).</>,
      <>Under <b>Settings → MCP</b>, click <b>Connect</b> next to <b>tasks</b>, then sign in here and <b>Allow</b>.</>,
      <>Add <code>#agent</code> to a card's title and paste the <a href="#prompt">starter prompt</a> into Cursor's agent.</>,
    ],
    code: (url) => JSON.stringify({ mcpServers: { tasks: { url } } }, null, 2),
    lang: "json",
  },
  {
    id: "codex",
    name: "Codex",
    steps: [
      <>Create an access token below, then run this in a terminal. It puts the token in <code>TASKS_TOKEN</code> for this shell, adds the board to <code>~/.codex/config.toml</code>, and starts Codex with the starter prompt.</>,
      <>Codex reads the token from the environment each time it starts, so add the <code>export</code> to <code>~/.zshrc</code> or similar to keep it working in new terminals.</>,
    ],
    code: (url, token) => codexQuickCommand(url, token),
    lang: "sh",
  },
  {
    id: "vscode",
    name: "VS Code",
    steps: [
      <>Add this to <code>.vscode/mcp.json</code>, or run <b>MCP: Open User Configuration</b> to use it in every workspace.</>,
      <>Start the server when VS Code asks, then sign in here and <b>Allow</b>. The tools appear in Copilot's agent mode.</>,
    ],
    code: (url) => JSON.stringify({ servers: { tasks: { type: "http", url } } }, null, 2),
    lang: "json",
  },
  {
    id: "claude",
    name: "Claude",
    steps: [
      <>In Claude (web or desktop), open <b>Settings → Connectors</b> and choose <b>Add custom connector</b>.</>,
      <>Name it <b>Tasks</b>, paste the URL above, and add it.</>,
      <>Click <b>Connect</b>. This site opens; sign in and choose <b>Allow</b>. Then ask Claude <i>“what's on my task list?”</i></>,
    ],
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    steps: [
      <>In ChatGPT, open <b>Settings → Apps &amp; Connectors</b>. Custom connectors need <b>Developer mode</b>, under <b>Advanced settings</b>.</>,
      <>Create a connector with the URL above and <b>OAuth</b> authentication.</>,
      <>ChatGPT sends you here to sign in and <b>Allow</b>. Then turn the connector on in a chat.</>,
    ],
  },
  {
    id: "glean",
    name: "Glean",
    steps: [
      <>A Glean admin opens <b>Admin console → Platform → Tools</b>, chooses <b>Add</b>, then <b>Import tools from MCP server</b>.</>,
      <>Set <b>MCP server URL</b> to the URL above and <b>Transport type</b> to <b>Streaming HTTP</b>.</>,
      <>For <b>Authentication method</b>, pick <b>Dynamic Client Registration</b>. Glean registers itself, and each person connects their own board the first time they use a tool.</>,
      <>Connect once as the admin so Glean can read the tool list, enable the tools, and publish. Then ask Glean Assistant <i>“what's on my task list?”</i> or add the tools to a Glean Agent.</>,
      <>Only want it for yourself? Use the <b>API Key</b> method with an access token instead. Everyone the tool is published to would then share your board.</>,
    ],
  },
  {
    id: "other",
    name: "Anything else",
    steps: [
      <>Any client that speaks MCP over <b>Streamable HTTP</b> works. Clients that support MCP's OAuth find everything from the URL alone and send you here to <b>Allow</b>.</>,
      <>Otherwise, create an access token below and send <code>Authorization: Bearer &lt;token&gt;</code>. For example:</>,
    ],
    code: (url, token) => `curl -s ${url} \\\n  -H "Authorization: Bearer ${token}" \\\n  -H "Content-Type: application/json" \\\n  -H "Accept: application/json, text/event-stream" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
    lang: "sh",
    codeAt: 1,
  },
];

// Where a machine keeps the token and the event feed script. The script already looks for the token here.
const HOME = "~/.config/tasks";
// One argument for a POSIX shell. Single quotes keep `$`, `!`, and backticks from meaning anything.
const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

const saveToken = (token: string) => `mkdir -p ${HOME} && echo '${token}' > ${HOME}/token && chmod 600 ${HOME}/token`;

const eventsCommand = () => feedCommand(location.origin, BASE);

// The one-command event feed setup. The Worker serves scripts/tasks-setup.mjs at /tasks/setup.mjs
// with the feed script inside it; the token rides in the environment, never in the URL.
const setupUrl = () => `${location.origin}${BASE}/setup.mjs`;
const setupCommand = (token: string) => `curl -fsSL ${setupUrl()} \\\n  | TASKS_TOKEN='${token}' \\\n    node --input-type=module -`;

// What to paste into a freshly connected agent. The rules themselves are in agent-rules.ts and
// the server hands them out through get_started, so the short prompt only has to say "call it".
// The full text is the same rules, for reading and for a client that should have them up front.
const PROMPTS = [
  { id: "short", name: "One line" },
  { id: "full", name: "The full rules" },
] as const;

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(api(path), { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const data = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? "Something went wrong. Try again.");
  return data;
}

function ago(ms: number | null): string {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  if (s < 90 * 60) return `${Math.round(s / 60)} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** The one-line Claude Code setup. The signed-out landing page shows the same command. */
export const claudeMcpAdd = (url: string) => `claude mcp add --transport http tasks ${url}`;

/**
 * The quick start's one command: connect Claude Code with a token and start it on the board.
 * Flags checked against `claude mcp add --help`, `claude mcp remove --help`, and `claude --help` (2.1).
 * - `claude mcp add` refuses a name that's already there, so the entry for this folder is removed
 *   first. That fails quietly when there isn't one. The new entry is local scope, which wins over
 *   a `tasks` in user or project scope.
 * - The prompt goes before --allowedTools, which takes a list and would swallow it.
 * - Everything is single-quoted and the prompt is one plain line, so nothing is left for the shell to expand.
 */
export const quickStartCommand = (url: string, token: string) =>
  `claude mcp remove tasks -s local >/dev/null 2>&1; ${claudeMcpAdd(url)} --header ${shq(`Authorization: Bearer ${token}`)} && claude ${shq(STARTER_LINE)} --allowedTools mcp__tasks`;

/** The same shape for Codex (`codex mcp add --help`, 0.150): it reads the token from the environment, and adding again replaces the entry. */
export const codexQuickCommand = (url: string, token: string) =>
  `export TASKS_TOKEN=${shq(token)} && codex mcp add tasks --url ${url} --bearer-token-env-var TASKS_TOKEN && codex ${shq(STARTER_LINE)}`;

export const QUICK_TOKEN_NAME = "Claude Code quick start";
/** Set by the Connect page's "Add a sample agent card", read by the board (FirstRun.tsx) when it opens. */
export const SAMPLE_INTENT = "tasks-add-sample";

/**
 * Copy text that isn't known yet. Safari only lets a page write to the clipboard during the
 * click, so the clipboard is handed a promise there and then; other browsers get writeText once
 * the text is in. False means neither worked and the text has to be copied from the page.
 */
async function copyLater(text: Promise<string>): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })]);
      return true;
    }
  } catch { /* try the plain way */ }
  try {
    await navigator.clipboard.writeText(await text);
    return true;
  } catch {
    return false;
  }
}

/** A quick start token nobody ever used is a command that was copied and never run. Clear those out so they don't eat the 10. */
async function mintQuickToken(): Promise<{ token: string; info: TokenInfo; dropped: string[] }> {
  const dropped: string[] = [];
  const { tokens } = await call<{ tokens: TokenInfo[] }>("/api/tokens");
  for (const t of tokens) {
    if (t.name !== QUICK_TOKEN_NAME || t.lastUsedAt) continue;
    await call(`/api/tokens/${encodeURIComponent(t.id)}`, { method: "DELETE" });
    dropped.push(t.id);
  }
  const r = await call<{ token: string; info: TokenInfo }>("/api/tokens", { method: "POST", body: JSON.stringify({ name: QUICK_TOKEN_NAME }) });
  return { ...r, dropped };
}

type Quick = { command: string; copied: boolean } | null;

/**
 * // QUICK_START: sign in, add a sample card, copy one command, paste it. The empty board shows
 * it (FirstRun.tsx) and so does the top of the Connect page. `sample` is how step 2 is done from
 * where this is drawn: the board adds the card, the Connect page goes to the board to add it.
 */
export function QuickStart({ signedIn, hasSample, onAddSample, onMinted, onConnect, onCopied, lede }: {
  signedIn: boolean;
  hasSample: boolean;
  onAddSample(): void;
  /** The Connect page lists tokens, so it's told about the new one and the unused ones it replaced. */
  onMinted?(info: TokenInfo, dropped: string[]): void;
  /** On the board: open the Connect page without leaving the app. */
  onConnect?(): void;
  /** Told each time the command lands on the clipboard, so the board can fold the steps away. */
  onCopied?(): void;
  lede: string;
}) {
  const [quick, setQuick] = useState<Quick>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = `${location.origin}${BASE}/mcp`;
  // On a phone the block scrolls inside the board, so the command is brought into view when it appears.
  const shown = useRef<HTMLDivElement>(null);
  const made = !!quick;
  useEffect(() => { if (made) shown.current?.scrollIntoView({ block: "nearest" }); }, [made]);

  async function copy() {
    setError(null);
    if (quick) {
      const copied = await copyLater(Promise.resolve(quick.command));
      setQuick({ ...quick, copied });
      if (copied) onCopied?.();
      return;
    }
    setBusy(true);
    const minted = mintQuickToken();
    const command = minted.then((r) => quickStartCommand(url, r.token));
    const copied = await copyLater(command);
    try {
      const r = await minted;
      setQuick({ command: await command, copied });
      onMinted?.(r.info, r.dropped);
      if (copied) onCopied?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const connectLink = (hash: string, text: string) => (
    <a href={`${BASE}/connect${hash}`} onClick={onConnect && ((e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); onConnect(); })}>{text}</a>
  );

  return (
    <>
      <p className="first-run-lede">{lede}</p>
      <ol className="quick-steps">
        <li className={signedIn ? "done" : undefined}>
          <b>Sign in</b>
          {signedIn
            ? <span>Done. You're signed in.</span>
            : <><span>Your email and a code. No password.</span><a className="btn primary" href={signInHref("#quick")}>Sign in</a></>}
        </li>
        <li className={hasSample ? "done" : undefined}>
          <b>Add a sample agent card</b>
          <span>A real card tagged <code>#agent</code>. The agent reads the folder you start it in, asks which small improvement to plan, and writes that plan on the card. It changes no files.</span>
          <button className={`btn${signedIn && !hasSample ? " primary" : ""}`} type="button" disabled={!signedIn || hasSample} onClick={onAddSample}>
            {hasSample ? <><IconCheck />Added</> : "Add a sample agent card"}
          </button>
        </li>
        <li>
          <b>Copy the command</b>
          <span>One line for Claude Code. It connects this board with a new access token and starts Claude on your <code>#agent</code> cards, with the board's tools approved ahead of time.</span>
          <button className={`btn${hasSample ? " primary" : ""}`} type="button" disabled={!signedIn || busy} onClick={() => void copy()}>
            {busy ? "Making it…" : quick?.copied ? <><IconCheck />Copied. Copy again</> : "Copy the command"}
          </button>
        </li>
        <li>
          <b>Paste it in a terminal</b>
          <span>In any folder. If Claude Code asks whether you trust it, pick Yes (Enter alone exits), then come back here. A question lands on the card. Tap an answer, and the plan goes in the card's notes and the card moves to Done. Nothing else needs approving in the terminal.</span>
        </li>
      </ol>
      {error && (
        <div className="login-error" role="alert">
          {error} {/tokens/.test(error) && connectLink("#apps", "See your tokens")}
        </div>
      )}
      {quick && (
        <div className="quick-cmd" role="status" ref={shown}>
          <Snippet lang="sh" code={quick.command} live wrap />
          <p>
            {quick.copied ? "Copied. " : "Your browser kept the clipboard to itself, so copy it from here. "}
            This is the only time this token is shown. It can read and change everything on your board.
          </p>
        </div>
      )}
      <p className="first-run-foot">
        <b>What the command does:</b> it adds an MCP server named <code>tasks</code>, with a new access
        token, to Claude Code's config for the folder you run it in (replacing one of that name). Then
        it starts Claude with a one-line prompt, allowed to use the board's tools without asking each
        time. That includes deleting cards and lanes; Undo on the board takes back anything an agent
        does. The command doesn't approve writing files or running commands: for anything that changes
        your machine, Claude Code still asks you in the terminal first. The token is shown once, in the command. It's on the command line, so your shell history keeps it too; revoke it any time under {connectLink("#apps", "Connected apps")}.
        OAuth is the other way, with no token on disk: {connectLink("#add", "the full steps")}, with Cursor and Codex too.
      </p>
    </>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn" type="button"
      onClick={() => void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}
    >
      {done ? <><IconCheck />Copied</> : label}
    </button>
  );
}

/** `live` marks a command that's ready to run as it stands: an orange `$` in front. `wrap` is for prose, like a prompt. */
function Snippet({ lang, code, live, wrap }: { lang: string; code: string; live?: boolean; wrap?: boolean }) {
  return (
    <div className="snippet">
      <div className="snippet-head">
        <span className="mono">{lang}</span>
        <CopyButton text={code} />
      </div>
      <pre className={[live && "live", wrap && "wrap"].filter(Boolean).join(" ") || undefined}>{code}</pre>
    </div>
  );
}

/** Where a signed-out visitor goes to sign in; they come back to this section afterwards. */
const signInHref = (hash = "") => `${BASE}/?next=${encodeURIComponent(`${BASE}/connect${hash}`)}`;

/** Saves the bundled script as a file. The browser puts it in Downloads; the step says where it goes. */
function DownloadButton({ name, text }: { name: string; text: string }) {
  return (
    <button
      className="btn" type="button"
      onClick={() => {
        const href = URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
        const a = Object.assign(document.createElement("a"), { href, download: name });
        a.click();
        setTimeout(() => URL.revokeObjectURL(href), 1000);
      }}
    >
      Download {name}
    </button>
  );
}

export function Connect({ signedIn, onBack }: { signedIn: boolean; onBack(): void }) {
  useTitle("Connect an agent");
  const url = `${location.origin}${BASE}/mcp`;
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ token: string; name: string; id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [client, setClient] = useState(() => {
    try { return localStorage.getItem("todo-connect-client") ?? "claude-code"; } catch { return "claude-code"; }
  });
  const [grants, setGrants] = useState<GrantInfo[] | null>(null);
  const [prompt, setPrompt] = useState<(typeof PROMPTS)[number]["id"]>("short");

  useEffect(() => {
    if (!signedIn) return;
    call<{ tokens: TokenInfo[] }>("/api/tokens").then((r) => setTokens(r.tokens)).catch((e: Error) => setError(e.message));
    call<{ grants: GrantInfo[] }>("/api/grants").then((r) => setGrants(r.grants)).catch((e: Error) => setError(e.message));
  }, [signedIn]);

  // Links like /tasks/connect#events land on their section. The page is drawn after the
  // browser looked for the anchor, so it has to be scrolled to here.
  useEffect(() => {
    if (location.hash.length > 1) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, []);

  async function disconnect(g: GrantInfo) {
    setError(null);
    try {
      await call(`/api/grants/${encodeURIComponent(g.id)}`, { method: "DELETE" });
      setGrants((all) => all?.filter((x) => x.id !== g.id) ?? null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function pick(id: string) {
    setClient(id);
    try { localStorage.setItem("todo-connect-client", id); } catch {}
  }

  // `named` is the event feed section's own button, which doesn't ask for a name.
  async function create(e: React.FormEvent | null, named = name) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ token: string; info: TokenInfo }>("/api/tokens", { method: "POST", body: JSON.stringify({ name: named }) });
      setFresh({ token: r.token, name: r.info.name, id: r.info.id });
      setTokens((t) => [r.info, ...(t ?? [])]);
      if (e) setName("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(t: TokenInfo) {
    setError(null);
    try {
      await call(`/api/tokens/${encodeURIComponent(t.id)}`, { method: "DELETE" });
      setTokens((all) => all?.filter((x) => x.id !== t.id) ?? null);
      if (fresh?.id === t.id) setFresh(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const active = CLIENTS.find((c) => c.id === client) ?? CLIENTS[0];
  const token = fresh?.token ?? PLACEHOLDER;
  const promptText = prompt === "full" ? fullPrompt(location.origin, BASE) : STARTER_LINE;

  // Step 2 of the quick start, from here: the board adds the card when it opens (FirstRun.tsx).
  function addSample() {
    try { sessionStorage.setItem(SAMPLE_INTENT, "1"); } catch { /* private window: the board has the button too */ }
    onBack();
  }

  return (
    <div className="connect">
      <header className="topbar">
        <h1 className="wordmark">tasks<span>.</span></h1>
        <span className="spacer" />
        {/* Signed out, back is the front page: someone who came from it or from the demo has a way out besides signing in. */}
        <a className="btn" href={`${BASE}/`} onClick={(e) => { e.preventDefault(); onBack(); }}>{signedIn ? "← Back to board" : "← Back to Tasks"}</a>
        {!signedIn && <a className="btn primary" href={signInHref()}>Sign in</a>}
      </header>

      <main className="connect-body">
        <section className="connect-intro">
          <h2 className="h">CONNECT_AN_AGENT</h2>
          <p className="lede">Put Claude Code, Cursor, or Codex to work on your board.</p>
          <p>
            Coding agents connect over <a href="https://modelcontextprotocol.io" target="_blank" rel="noreferrer">MCP</a>,
            and so do Claude, ChatGPT, Glean, and any other MCP client. They get the same tools as the
            built-in assistant, so their changes show up live on the board and <kbd>⌘Z</kbd> undoes them.
          </p>
          {!signedIn && (
            <p>
              You're not signed in. Everything here is readable without an account;
              you'll <a href={signInHref()}>sign in</a> to copy a command or when your agent asks for access.
            </p>
          )}
        </section>

        <section className="first-run quick-start" id="quick" aria-labelledby="quick-h">
          <h2 className="h" id="quick-h">QUICK_START</h2>
          <QuickStart
            signedIn={signedIn} hasSample={false} onAddSample={addSample}
            lede="Claude Code working a card on your board, in four steps."
            onMinted={(info, dropped) => setTokens((t) => [info, ...(t ?? []).filter((x) => !dropped.includes(x.id))])}
          />
        </section>

        <p className="connect-rest">
          Not on Claude Code, or want OAuth instead of a token? <a href="#add">Add the URL to your agent</a> and
          paste in the <a href="#prompt">starter prompt</a>. After that, read <a href="#working">how
          the <code>#agent</code> tag, questions, and claims work</a>.
        </p>

        <section className="connect-step">
          <div className="step-num">01</div>
          <div className="step-main">
            <h2 className="h">SERVER_URL</h2>
            <div className="copy-row">
              <code className="mono-box">{url}</code>
              <CopyButton text={url} />
            </div>
            <p className="muted">Streamable HTTP. Signs in with OAuth, or with an access token as <code>Authorization: Bearer &lt;token&gt;</code>.</p>
          </div>
        </section>

        <section className="connect-step" id="add">
          <div className="step-num">02</div>
          <div className="step-main">
            <h2 className="h">ADD_IT_TO_YOUR_AGENT</h2>
            <div className="client-tabs" role="tablist" aria-label="Agent">
              {CLIENTS.map((c) => (
                <button key={c.id} role="tab" aria-selected={c.id === active.id} onClick={() => pick(c.id)}>{c.name}</button>
              ))}
            </div>
            <div className="client-panel" role="tabpanel">
              <ol>
                {active.steps.map((s, i) => (
                  <li key={i}>
                    {s}
                    {/* The snippet sits in the step that says "run this" or "add this", not under the whole list. */}
                    {active.code && i === (active.codeAt ?? 0) && <Snippet lang={active.lang ?? ""} code={active.code(url, token)} />}
                  </li>
                ))}
              </ol>
              {!fresh && needsToken(active) && <p className="muted">Swap <code>{PLACEHOLDER}</code> for your token, or create one below and it fills in here.</p>}
            </div>
          </div>
        </section>

        <section className="connect-step" id="prompt">
          <div className="step-num">03</div>
          <div className="step-main">
            <h2 className="h">START_IT_WITH_THIS_PROMPT</h2>
            <p>
              Add <code>#agent</code> to the title of a card you want done, or use its Tags field, then
              paste this into the agent you just connected. The one line has the agent
              call <code>get_started</code>, and the server answers with the working rules: which cards
              are its own, to claim one before starting, to keep a status line on it, to ask you instead
              of guessing or when it's stuck, to wait for your answer, and to move the card to Done.
            </p>
            <div className="client-tabs" role="tablist" aria-label="Prompt">
              {PROMPTS.map((p) => (
                <button key={p.id} role="tab" aria-selected={p.id === prompt} onClick={() => setPrompt(p.id)}>{p.name}</button>
              ))}
            </div>
            <Snippet lang="prompt" code={promptText} wrap />
            {prompt === "full" ? (
              <p className="muted">
                The same rules <code>get_started</code> returns, word for word, for reading or for pasting whole.
              </p>
            ) : (
              <p className="muted">
                The rules live on the server, so this line never goes stale. Read them under <b>The full rules</b>.
              </p>
            )}
            <p className="muted">
              <b>Getting your answer back to it.</b> While a question is open, the rules have the agent
              call <code>wait_for_answer</code>, which holds until you answer and hands it the card, for
              up to 10 minutes. That works in any MCP client, with no shell. After 10 minutes it stops
              and says so: tell it <i>“check the board”</i>. With the <a href="#events">event feed</a> installed
              on a machine, Claude Code can also listen for new cards and edits as well as answers.
              The same prompt works either way.
            </p>
          </div>
        </section>

        <section className="connect-step" id="apps">
          <div className="step-num">04</div>
          <div className="step-main">
            <h2 className="h">CONNECTED_APPS</h2>
            {!signedIn ? (
              <>
                <p className="muted">
                  Apps you allow show up here, and you can disconnect them at any time. Most agents sign you
                  in themselves and never need a token. For the ones that take a pasted token, like Codex,
                  and for the event feed below, you create one here.
                </p>
                <div className="step-actions"><a className="btn primary" href={signInHref("#apps")}>Sign in to create a token</a></div>
              </>
            ) : <>
            {grants && grants.length > 0 ? (
              <table className="token-table">
                <thead><tr><th>App</th><th>Connected</th><th /></tr></thead>
                <tbody>
                  {grants.map((g) => (
                    <tr key={g.id}>
                      <td>{g.name}</td>
                      <td className="mono">{ago(g.createdAt)}</td>
                      <td><button className="btn danger" onClick={() => void disconnect(g)} title={`Disconnect ${g.name}`} aria-label={`Disconnect ${g.name}`}><IconTrash /><span className="hide-sm">Disconnect</span></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">{grants ? "Nothing yet. Apps you allow show up here, and you can disconnect them at any time." : "Loading…"}</p>
            )}

            <h3 className="subhead">Access tokens</h3>
            <p className="muted">For agents that take a pasted token instead of signing in, like Codex or Glean's API Key method. Make one per agent so you can revoke each on its own. A token can read and change everything on your board.</p>
            <form className="token-form" onSubmit={create}>
              <label className="sr-only" htmlFor="token-name">Token name</label>
              <input
                id="token-name" className="field" placeholder="Name it after the agent, like “Codex”" maxLength={60}
                value={name} onChange={(e) => setName(e.target.value)}
              />
              <button className="btn primary" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create token"}</button>
            </form>

            {fresh && (
              <div className="fresh-token" role="status">
                <div className="copy-row">
                  <code className="mono-box live">{fresh.token}</code>
                  <CopyButton text={fresh.token} />
                </div>
                <p>Copy it now. This is the only time <b>{fresh.name}</b>'s token is shown. Snippets on this page that need a token already include it.</p>
              </div>
            )}

            {error && <div className="login-error" role="alert">{error}</div>}

            {tokens && tokens.length > 0 && (
              <table className="token-table">
                <thead><tr><th>Name</th><th>Created</th><th>Last used</th><th /></tr></thead>
                <tbody>
                  {tokens.map((t) => (
                    <tr key={t.id}>
                      <td>{t.name}</td>
                      <td className="mono">{ago(t.createdAt)}</td>
                      <td className="mono">{ago(t.lastUsedAt)}</td>
                      <td><button className="btn danger" onClick={() => void revoke(t)} title={`Revoke ${t.name}`} aria-label={`Revoke ${t.name}`}><IconTrash /><span className="hide-sm">Revoke</span></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            </>}
          </div>
        </section>

        <section className="connect-step" id="events">
          <div className="step-num">05</div>
          <div className="step-main">
            <h2 className="h">EVENT_FEED</h2>
            <p>
              Optional, and for Claude Code. The event feed prints one line each time you add, edit,
              move, answer, or delete an <code>#agent</code> card, so an agent on your machine hears
              about it without polling. An agent already waits for your answers
              with <code>wait_for_answer</code>, so skip this unless you want it to pick up new cards
              and edits by itself. Each machine needs this once.
            </p>
            <Snippet lang="sh" code={setupCommand(token)} live={!!fresh} />
            {fresh ? (
              <p className="muted">
                Your new token (<b>{fresh.name}</b>) is filled in. Copy the command now: the token isn't
                shown again once you leave this page.
              </p>
            ) : signedIn ? (
              <div className="setup-token">
                <p className="muted">The command needs a token where it says <code>{PLACEHOLDER}</code>. Create one and it fills in.</p>
                <button className="btn primary" type="button" disabled={busy} onClick={() => void create(null, "Event feed")}>
                  {busy ? "Creating…" : "Create a token"}
                </button>
              </div>
            ) : (
              <div className="setup-token">
                <p className="muted">The command needs a token where it says <code>{PLACEHOLDER}</code>.</p>
                <a className="btn primary" href={signInHref("#events")}>Sign in to create a token</a>
              </div>
            )}
            {error && signedIn && !fresh && <div className="login-error" role="alert">{error}</div>}
            <p>
              <b>What it changes:</b> it saves the token to <code>{HOME}/token</code> (mode 600) and
              puts <code>tasks-events.mjs</code> next to it. Nothing starts running: the feed runs only
              when you tell an agent to use it.
            </p>
            <p>
              <b>If this machine had the Sessions hooks:</b> Tasks used to list Claude Code sessions,
              fed by seven hooks in <code>~/.claude/settings.json</code>. That's gone, and the hooks
              do nothing now. This command takes them back out, after saving a backup beside the file,
              and keeps every other hook and setting.
            </p>
            <p className="muted">
              Needs Node 22 or later and nothing else. <a href={setupUrl()} target="_blank" rel="noreferrer">Read the
              script</a> before you run it, or add <code>--dry-run</code> to the end to see what it would do.
            </p>
            <details className="by-hand">
              <summary>Do it by hand</summary>
              <div className="client-panel">
                <ol>
                  <li>
                    Create an access token above and save it on the machine. The script reads it from this file:
                    <Snippet lang="sh" code={saveToken(token)} />
                  </li>
                  <li>
                    Download the script and move it to <code>{HOME}/tasks-events.mjs</code>. It's one file
                    and needs Node 22 or later, nothing else.
                    <div className="step-actions">
                      <DownloadButton name="tasks-events.mjs" text={eventsScript} />
                    </div>
                  </li>
                  <li>
                    If <code>~/.claude/settings.json</code> has hooks that
                    run <code>tasks-presence.mjs</code>, delete them. They're left over from Sessions.
                  </li>
                </ol>
              </div>
            </details>
          </div>
        </section>

        <section className="connect-step" id="working">
          <div className="step-num">06</div>
          <div className="step-main">
            <h2 className="h">WORKING_WITH_AN_AGENT</h2>
            <ul className="connect-notes">
              <li>
                <b>Start it with the prompt.</b>
                <p>
                  The <a href="#prompt">starter prompt</a> has the agent read the rules for everything below
                  from the server. Paste it in at the start of a session.
                </p>
                <div className="step-actions">
                  <CopyButton text={STARTER_LINE} label="Copy starter prompt" />
                </div>
              </li>
              <li>
                <b>Tag its cards <code>#agent</code>.</b>
                <p>
                  Add <code>#agent</code> to the end of a card's title, or use its Tags field. The agent lists them
                  with <code>get_board</code> and <code>tag: "agent"</code>, and leaves every other card alone.
                  With more than one project, add a second tag for each, like <code>#receptionist</code>.
                </p>
              </li>
              <li>
                <b>It asks, you answer.</b>
                <p>
                  When an agent needs a decision it calls <code>ask_ceo</code>. The card gets <code>#needs-ceo</code> and
                  shows the question with a button for each option, and the top bar counts what's waiting on
you. One tap answers it. The answer is kept on the card. An agent that can't go on, say
                  because a tool was refused, asks the same way instead of stopping quietly.
                </p>
              </li>
              <li>
                <b>One card, one agent.</b>
                <p>
                  An agent calls <code>claim_card</code> before it starts a card, so two agents never work the
                  same one. The server hands each agent a session id to claim with
                  when it calls <code>get_started</code>, and a second agent that asks for a claimed card
                  is refused. A claim ends when the card is done or deleted, when the agent gives it
                  back, and 15 minutes after the agent's last call. The server tells every agent about
                  claims and questions when it connects, so you don't have to.
                </p>
              </li>
              <li>
                <b>It hears your changes.</b>
                <p>
                  The event feed prints one line of JSON each time you add, edit, move, answer, or delete
                  an <code>#agent</code> card, so an agent on your machine can act on it without polling.
                  The <a href="#events">one command above</a> installs it
                  as <code>{HOME}/tasks-events.mjs</code>, next to the token it uses. It runs under Claude
                  Code's Monitor tool, and only when you ask: tell the agent to use the event feed, and
                  Claude Code asks once in the terminal before it runs the script. Left alone, an agent
                  never starts it, and waits for your answer with <code>wait_for_answer</code>. Changes an agent
                  makes are left out, so it never wakes itself.
                </p>
                <Snippet lang="sh" code={eventsCommand()} />
              </li>
            </ul>
            <p className="muted">
              An end-to-end encrypted board is closed to all of this. The server can't read it, so there are
              no agent tools, no claims, and no event feed.
            </p>
          </div>
        </section>

        <section className="connect-tools" id="tools">
          <h2 className="h">WHAT_AGENTS_CAN_DO</h2>
          <ul>
            {TOOL_LIST.map((t) => (
              <li key={t.name}>
                <code>{t.name}</code>
                <span>{t.about}</span>
                {t.destructive && <span className="chip overdue">destructive</span>}
              </li>
            ))}
          </ul>
        </section>
      </main>
      <Footer />
    </div>
  );
}
