import { useEffect, useState } from "react";
import type { GrantInfo } from "../oauth";
import type { TokenInfo } from "../tokens";
import { api, BASE } from "./base";
import { Footer } from "./Footer";
import { IconCheck, IconTrash } from "./icons";

// Instructions for connecting outside agents to the board over MCP, the apps
// already connected with OAuth, and personal access tokens for clients that take a
// pasted token instead. Lives at /tasks/connect.

const PLACEHOLDER = "<YOUR_TOKEN>";

type Client = {
  id: string;
  name: string;
  steps: React.ReactNode[];
  code?: (url: string, token: string) => string;
  lang?: string;
};

/** Snippets that contain a token placeholder. */
const needsToken = (c: Client) => !!c.code && c.code("", PLACEHOLDER).includes(PLACEHOLDER);

const CLIENTS: Client[] = [
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
    id: "claude-code",
    name: "Claude Code",
    steps: [
      <>Run this once in a terminal.</>,
      <>Start Claude Code, run <code>/mcp</code>, pick <b>tasks</b>, and choose <b>Authenticate</b>. Your browser opens here; sign in and <b>Allow</b>.</>,
      <>Prefer a token? Add <code>--header "Authorization: Bearer &lt;token&gt;"</code> to the command and skip step 2.</>,
    ],
    code: (url) => `claude mcp add --transport http tasks ${url}`,
    lang: "sh",
  },
  {
    id: "cursor",
    name: "Cursor",
    steps: [
      <>Add this to <code>~/.cursor/mcp.json</code> (or <code>.cursor/mcp.json</code> in a project).</>,
      <>Under <b>Settings → MCP</b>, click <b>Connect</b> next to <b>tasks</b>, then sign in here and <b>Allow</b>.</>,
    ],
    code: (url) => JSON.stringify({ mcpServers: { tasks: { url } } }, null, 2),
    lang: "json",
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
    id: "codex",
    name: "Codex",
    steps: [<>Add this to <code>~/.codex/config.toml</code>, create an access token below, and export it in your shell as <code>TASKS_TOKEN</code>.</>],
    code: (url, token) => `[mcp_servers.tasks]\nurl = "${url}"\nbearer_token_env_var = "TASKS_TOKEN"\n\n# in ~/.zshrc or similar:\n# export TASKS_TOKEN="${token}"`,
    lang: "toml",
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
  },
];

const TOOLS: [string, string, boolean?][] = [
  ["get_board", "Read every lane and card, with ids, due dates, and notes"],
  ["search_cards", "Find cards by keywords or by meaning across titles and notes"],
  ["add_cards", "Create one or more cards, in any lane, with notes and due dates"],
  ["move_cards", "Move cards between lanes, for example to Done"],
  ["update_card", "Change a card's title, notes, or due date"],
  ["delete_cards", "Delete cards", true],
  ["add_lane", "Add a lane"],
  ["rename_lane", "Rename a lane"],
  ["delete_lane", "Delete a lane and every card in it", true],
];

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

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
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

export function Connect({ onBack }: { onBack(): void }) {
  const url = `${location.origin}${BASE}/mcp`;
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [name, setName] = useState("");
  const [fresh, setFresh] = useState<{ token: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [client, setClient] = useState(() => {
    try { return localStorage.getItem("todo-connect-client") ?? "claude"; } catch { return "claude"; }
  });
  const [grants, setGrants] = useState<GrantInfo[] | null>(null);

  useEffect(() => {
    call<{ tokens: TokenInfo[] }>("/api/tokens").then((r) => setTokens(r.tokens)).catch((e: Error) => setError(e.message));
    call<{ grants: GrantInfo[] }>("/api/grants").then((r) => setGrants(r.grants)).catch((e: Error) => setError(e.message));
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

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ token: string; info: TokenInfo }>("/api/tokens", { method: "POST", body: JSON.stringify({ name }) });
      setFresh({ token: r.token, name: r.info.name });
      setTokens((t) => [r.info, ...(t ?? [])]);
      setName("");
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
      if (fresh?.name === t.name) setFresh(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const active = CLIENTS.find((c) => c.id === client) ?? CLIENTS[0];
  const token = fresh?.token ?? PLACEHOLDER;

  return (
    <div className="connect">
      <header className="topbar">
        <h1 className="wordmark">tasks<span>.</span></h1>
        <span className="spacer" />
        <a className="btn" href={`${BASE}/`} onClick={(e) => { e.preventDefault(); onBack(); }}>← Back to board</a>
      </header>

      <main className="connect-body">
        <section className="connect-intro">
          <h2 className="h">CONNECT_AN_AGENT</h2>
          <p className="lede">Let Claude, ChatGPT, Glean, and other AI agents work your board.</p>
          <p>
            Agents connect over <a href="https://modelcontextprotocol.io" target="_blank" rel="noreferrer">MCP</a>. They
            get the same tools as the built-in assistant, so their changes show up live in this tab
            and <kbd>⌘Z</kbd> undoes them. Most agents need only the URL: they send you back here to
            sign in and allow access.
          </p>
        </section>

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

        <section className="connect-step">
          <div className="step-num">02</div>
          <div className="step-main">
            <h2 className="h">ADD_IT_TO_YOUR_AGENT</h2>
            <div className="client-tabs" role="tablist" aria-label="Agent">
              {CLIENTS.map((c) => (
                <button key={c.id} role="tab" aria-selected={c.id === active.id} onClick={() => pick(c.id)}>{c.name}</button>
              ))}
            </div>
            <div className="client-panel" role="tabpanel">
              <ol>{active.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
              {active.code && (
                <div className="snippet">
                  <div className="snippet-head">
                    <span className="mono">{active.lang}</span>
                    <CopyButton text={active.code(url, token)} />
                  </div>
                  <pre>{active.code(url, token)}</pre>
                </div>
              )}
              {!fresh && needsToken(active) && <p className="muted">Swap <code>{PLACEHOLDER}</code> for your token, or create one below and it fills in here.</p>}
            </div>
          </div>
        </section>

        <section className="connect-step">
          <div className="step-num">03</div>
          <div className="step-main">
            <h2 className="h">CONNECTED_APPS</h2>
            {grants && grants.length > 0 ? (
              <table className="token-table">
                <thead><tr><th>App</th><th>Connected</th><th /></tr></thead>
                <tbody>
                  {grants.map((g) => (
                    <tr key={g.id}>
                      <td>{g.name}</td>
                      <td className="mono">{ago(g.createdAt)}</td>
                      <td><button className="btn danger" onClick={() => void disconnect(g)} title={`Disconnect ${g.name}`}><IconTrash /><span className="hide-sm">Disconnect</span></button></td>
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
                <p>Copy it now. This is the only time <b>{fresh.name}</b>'s token is shown. Snippets above that need a token already include it.</p>
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
                      <td><button className="btn danger" onClick={() => void revoke(t)} title={`Revoke ${t.name}`}><IconTrash /><span className="hide-sm">Revoke</span></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="connect-tools">
          <h2 className="h">WHAT_AGENTS_CAN_DO</h2>
          <ul>
            {TOOLS.map(([n, d, destructive]) => (
              <li key={n}>
                <code>{n}</code>
                <span>{d}</span>
                {destructive && <span className="chip overdue">destructive</span>}
              </li>
            ))}
          </ul>
        </section>
      </main>
      <Footer />
    </div>
  );
}
