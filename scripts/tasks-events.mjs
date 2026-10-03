#!/usr/bin/env node
// Stream the changes you make to #agent cards on your Tasks board, one JSON object per
// line on stdout. Built for Claude Code's Monitor tool, where each line wakes the session:
//
//   node scripts/tasks-events.mjs
//
// The first line after each connect is {"type":"hello","cards":[…]}: every open #agent
// card, so nothing is missed while offline. After that, one line per change you make:
// added, tagged, answered (#needs-ceo came off), edited, moved, deleted. Changes an agent
// makes over MCP never show up here.
//
// Token: TASKS_TOKEN, or the first line of ~/.config/tasks/token (a personal access token
// from Connect an agent → Tokens). URL: TASKS_URL, default wss://askscottpierce.com/tasks/events.
// Needs Node 22 or later (built-in WebSocket). Reconnects on its own; status goes to stderr.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const URL_ = process.env.TASKS_URL ?? "wss://askscottpierce.com/tasks/events";
const PING_MS = 30_000; // Cloudflare drops sockets that sit silent for about 100 seconds
const MAX_BACKOFF_MS = 30_000;

function token() {
  if (process.env.TASKS_TOKEN) return process.env.TASKS_TOKEN.trim();
  try {
    return readFileSync(join(homedir(), ".config", "tasks", "token"), "utf8").split("\n")[0].trim();
  } catch {
    console.error("tasks-events: set TASKS_TOKEN or put a token in ~/.config/tasks/token");
    process.exit(2);
  }
}

const say = (line) => process.stdout.write(line + "\n");
const log = (msg) => process.stderr.write(`tasks-events: ${msg}\n`);

const tok = token();
let backoff = 1000;
let lastHello = "";

function connect() {
  const ws = new WebSocket(URL_, ["tasks-events", tok]);
  let ping;
  ws.onopen = () => {
    backoff = 1000;
    log(`connected to ${URL_}`);
    ping = setInterval(() => ws.send("ping"), PING_MS);
  };
  ws.onmessage = (m) => {
    if (m.data === "pong") return;
    let line;
    try { line = JSON.stringify(JSON.parse(String(m.data))); } catch { return; }
    // A reconnect resends the queue; only pass it on when it changed.
    if (line.startsWith('{"type":"hello"')) {
      if (line === lastHello) return;
      lastHello = line;
    }
    say(line);
  };
  ws.onclose = (e) => {
    clearInterval(ping);
    if (e.code === 1008 || e.code === 4001) { log(`refused: ${e.reason || e.code}`); process.exit(1); }
    log(`disconnected (${e.code}); retrying in ${Math.round(backoff / 1000)}s`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  };
  ws.onerror = () => {}; // onclose follows with the details
}

connect();
