#!/usr/bin/env node
// Tell Tasks this Claude Code session is alive, from a hook. Reads the hook's JSON on stdin,
// keeps the few fields the // SESSIONS panel shows, and posts about 200 bytes:
//
//   {"type":"command","command":"node ~/code/todo-agent/scripts/tasks-presence.mjs","async":true}
//
// Everything else in the hook payload stays on this machine: the prompt, tool output, the
// assistant's last message, the transcript path, and any Bash command. (A hook of type "http"
// sends the whole payload and leaves the trimming to the server.)
//
// Token: TASKS_TOKEN, or the first line of ~/.config/tasks/token, the same one
// tasks-events.mjs uses. URL: TASKS_PRESENCE_URL, default https://askscottpierce.com/tasks/api/presence.
// Machine name: TASKS_MACHINE, default this host's name.
//
// It never prints, never fails the hook, and gives up after 3 seconds. PostToolUse fires on
// every tool call, so those are sent at most once every 30 seconds per session.

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";

const URL_ = process.env.TASKS_PRESENCE_URL ?? "https://askscottpierce.com/tasks/api/presence";
const ROUTINE_EVERY_MS = 30_000;
const ROUTINE = new Set(["PreToolUse", "PostToolUse", "SubagentStop"]);

function token() {
  if (process.env.TASKS_TOKEN) return process.env.TASKS_TOKEN.trim();
  try { return readFileSync(join(homedir(), ".config", "tasks", "token"), "utf8").split("\n")[0].trim(); } catch { return ""; }
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const h = JSON.parse(raw);
  const id = String(h.session_id ?? "");
  const tok = token();
  if (!id || !tok) return;

  const event = String(h.hook_event_name ?? "");
  if (ROUTINE.has(event)) {
    const stamp = join(tmpdir(), `tasks-presence-${id.replace(/[^\w.-]/g, "_")}`);
    try { if (Date.now() - statSync(stamp).mtimeMs < ROUTINE_EVERY_MS) return; } catch { /* first one */ }
    try { writeFileSync(stamp, ""); } catch { /* still send */ }
  }

  const input = h.tool_input && typeof h.tool_input === "object" ? h.tool_input : {};
  const body = {
    session_id: id,
    cwd: h.cwd,
    hook_event_name: event,
    tool_name: h.tool_name,
    tool_input: { file_path: input.file_path ?? input.notebook_path, description: input.description },
    message: h.message,
    notification_type: h.notification_type,
  };
  await fetch(URL_, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tok}`,
      "X-Tasks-Machine": process.env.TASKS_MACHINE ?? hostname().replace(/\.local$/, ""),
      ...(process.env.CLAUDE_CODE_AGENT ? { "X-Tasks-Agent": process.env.CLAUDE_CODE_AGENT } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });
}

main().catch(() => {}).finally(() => process.exit(0));
