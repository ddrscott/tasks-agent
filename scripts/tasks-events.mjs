#!/usr/bin/env node
// Stream the changes you make to #agent cards on your Tasks board, one JSON object per
// line on stdout. Built for Claude Code's Monitor tool, where each line wakes the session:
//
//   node scripts/tasks-events.mjs
//
// The first line after each connect is {"type":"hello","cards":[…]}: every open #agent
// card, so nothing is missed while offline. After that, one line per change you make:
// added, tagged, answered (#needs-ceo came off), edited, moved, deleted. Changes an agent
// makes over MCP never show up here. After 5 failed connects in a row it prints one
// {"type":"offline",…} line (a bad token looks the same as Tasks being unreachable), keeps
// retrying, and passes on the next hello when it's back.
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
const OFFLINE_AFTER = 5; // failed connects in a row before saying so on stdout

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
let failures = 0;

function retry(why) {
  failures++;
  if (failures === OFFLINE_AFTER) {
    say(JSON.stringify({ type: "offline", attempts: failures, reason: "can't connect: a revoked or wrong token, or Tasks is unreachable" }));
    lastHello = ""; // say hello again once it's back
  }
  log(`${why}; retrying in ${Math.round(backoff / 1000)}s`);
  setTimeout(connect, backoff);
  backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
}

function connect() {
  const ws = new WebSocket(URL_, ["tasks-events", tok]);
  let ping;
  let opened = false;
  ws.onopen = () => {
    opened = true;
    failures = 0;
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
    if (opened) retry(`disconnected (${e.code})`);
  };
  // A refused upgrade (401 for a bad token) fires only this, and onclose never comes.
  // Detach first: closing a failed socket can fire error again.
  ws.onerror = () => {
    if (opened) return; // onclose follows
    ws.onerror = ws.onclose = ws.onmessage = ws.onopen = null;
    retry("couldn't connect");
  };
}

connect();
