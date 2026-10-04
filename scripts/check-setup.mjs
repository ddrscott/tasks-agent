#!/usr/bin/env node
// Check the one-command Sessions setup (scripts/tasks-setup.mjs) the way people run it: the file
// the Worker serves (src/setup.ts), piped into `node --input-type=module -`, against a throwaway
// HOME and a stand-in server on localhost. It never touches the real ~/.claude or ~/.config.
// Exits 1 on a failure.
//
//   npm run check:setup

import { build } from "esbuild";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;
const cache = join(root, "node_modules", ".cache", "check-setup");
const outfile = join(cache, `setup-${process.pid}.mjs`);
await build({ entryPoints: [join(root, "src/setup.ts")], outfile, bundle: true, format: "esm", platform: "node", logLevel: "error" });
const { buildSetup } = await import(pathToFileURL(outfile).href);
rmSync(cache, { recursive: true, force: true });

const read = (name) => readFileSync(join(root, "scripts", name), "utf8");
const installer = read("tasks-setup.mjs");
const files = { "tasks-presence.mjs": read("tasks-presence.mjs"), "tasks-events.mjs": read("tasks-events.mjs") };

// Stands in for Tasks: knows one token, refuses the rest, and remembers what it was asked.
const GOOD = "tasks_check_0123456789abcdef";
const requests = [];
const server = createServer((req, res) => {
  requests.push(req.url);
  const ok = req.method === "POST" && req.url === "/tasks/api/presence" && req.headers.authorization === `Bearer ${GOOD}`;
  res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" }).end("{}");
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const served = buildSetup(installer, files, origin);

let failed = 0;
function check(name, got, want = true) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(ok ? `ok   ${name}` : `FAIL ${name}\n     wanted ${JSON.stringify(want)}\n     got    ${JSON.stringify(got)}`);
}

const homes = [];
function newHome() {
  const home = mkdtempSync(join(tmpdir(), "tasks-setup-"));
  homes.push(home);
  return home;
}

/** Pipe a script into node the way the Connect page's command does. Only HOME, PATH, and what's passed reach it. */
function run(home, { token, script = served, args = [] } = {}) {
  return new Promise((done) => {
    const env = { HOME: home, PATH: process.env.PATH, ...(token === undefined ? {} : { TASKS_TOKEN: token }) };
    const child = spawn(process.execPath, ["--input-type=module", "-", ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => done({ code, out }));
    child.stdin.end(script);
  });
}

const settingsPath = (home) => join(home, ".claude", "settings.json");
const settingsOf = (home) => JSON.parse(readFileSync(settingsPath(home), "utf8"));
const backupsIn = (home) => (existsSync(join(home, ".claude")) ? readdirSync(join(home, ".claude")).filter((f) => f.includes(".tasks-backup-")) : []);
const mode = (path) => (statSync(path).mode & 0o777).toString(8);
const EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "PermissionRequest", "Notification", "Stop", "SessionEnd"];
const ASYNC = ["UserPromptSubmit", "PostToolUse"];
const COMMAND = `TASKS_PRESENCE_URL=${origin}/tasks/api/presence node ~/.config/tasks/tasks-presence.mjs`;
const ours = (settings, event) => (settings.hooks[event] ?? []).flatMap((g) => g.hooks).filter((h) => h.command?.includes("tasks-presence.mjs"));
/** The backup path the script printed, with ~ put back to home and links followed. null when it names no file. */
function printedBackup(out, home) {
  const printed = /^saved (.+)$/m.exec(out)?.[1];
  if (!printed) return null;
  const path = printed === "~" || printed.startsWith("~/") ? join(home, printed.slice(1)) : printed;
  return existsSync(path) ? realpathSync(path) : null;
}
function writeSettings(home, text) {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(settingsPath(home), text);
}

// 1. A machine with no settings.json.
{
  const home = newHome();
  const r = await run(home, { token: GOOD });
  check("fresh machine: exits 0", r.code, 0);
  check("fresh machine: the token file holds the token", readFileSync(join(home, ".config/tasks/token"), "utf8"), GOOD + "\n");
  check("fresh machine: the token file is mode 600", mode(join(home, ".config/tasks/token")), "600");
  check("fresh machine: tasks-presence.mjs is the repo's", readFileSync(join(home, ".config/tasks/tasks-presence.mjs"), "utf8") === files["tasks-presence.mjs"]);
  check("fresh machine: tasks-events.mjs is the repo's", readFileSync(join(home, ".config/tasks/tasks-events.mjs"), "utf8") === files["tasks-events.mjs"]);
  const s = settingsOf(home);
  check("fresh machine: settings.json holds only hooks", Object.keys(s), ["hooks"]);
  check("fresh machine: the seven events, in order", Object.keys(s.hooks), EVENTS);
  check("fresh machine: one hook per event", EVENTS.map((e) => ours(s, e).length), EVENTS.map(() => 1));
  check("fresh machine: each hook runs the installed script", EVENTS.every((e) => ours(s, e)[0].type === "command" && ours(s, e)[0].command === COMMAND));
  check("fresh machine: only the two busy events run in the background", EVENTS.filter((e) => ours(s, e)[0].async === true), ASYNC);
  check("fresh machine: no backup, there was nothing to back up", backupsIn(home), []);
  check("fresh machine: the token isn't printed", r.out.includes(GOOD), false);
}

// 2. A settings.json with other hooks and settings, then 3. the same command a second time.
{
  const home = newHome();
  const mine = {
    model: "opus",
    permissions: { allow: ["Bash(npm run *)"], deny: ["Read(./.env)"] },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "~/bin/guard.sh" }] }],
      PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "npx prettier --write", timeout: 10 }] }],
      Stop: [{ hooks: [{ type: "command", command: "afplay /System/Library/Sounds/Glass.aiff" }] }],
    },
    env: { FOO: "bar" },
    statusLine: { type: "command", command: "~/bin/status" },
  };
  // Tabs, so the backup can be told from a rewrite.
  const original = JSON.stringify(mine, null, "\t") + "\n";
  writeSettings(home, original);
  const r = await run(home, { token: GOOD });
  check("existing settings: exits 0", r.code, 0);
  const s = settingsOf(home);
  check("existing settings: top-level keys and their order are kept", Object.keys(s), Object.keys(mine));
  check("existing settings: every other setting is untouched", { ...s, hooks: null }, { ...mine, hooks: null });
  check("existing settings: a hook on an event we don't use is untouched", s.hooks.PreToolUse, mine.hooks.PreToolUse);
  check("existing settings: the PostToolUse hook is kept, ahead of ours", s.hooks.PostToolUse[0], mine.hooks.PostToolUse[0]);
  check("existing settings: the Stop hook is kept, ahead of ours", s.hooks.Stop[0], mine.hooks.Stop[0]);
  check("existing settings: ours is added once per event", EVENTS.map((e) => ours(s, e).length), EVENTS.map(() => 1));
  check("existing settings: nothing else was added", Object.keys(s.hooks).sort(), [...EVENTS, "PreToolUse"].sort());
  check("existing settings: one backup", backupsIn(home).length, 1);
  check("existing settings: the backup is the old file, byte for byte", readFileSync(join(home, ".claude", backupsIn(home)[0]), "utf8"), original);
  // The temp HOME is under /var on a Mac, which is really /private/var: the path once printed as "/private~/.claude/…".
  check("existing settings: the printed backup path is a file that exists", printedBackup(r.out, home), realpathSync(join(home, ".claude", backupsIn(home)[0])));
  check("existing settings: the backup is printed with ~ for home", /^saved ~\/\.claude\/settings\.json\.tasks-backup-\d{14}$/m.test(r.out));

  const afterFirst = readFileSync(settingsPath(home), "utf8");
  const again = await run(home); // no TASKS_TOKEN: it uses the one it saved
  check("second run: exits 0 without TASKS_TOKEN", again.code, 0);
  check("second run: settings.json is byte for byte the same", readFileSync(settingsPath(home), "utf8"), afterFirst);
  check("second run: still one hook per event", EVENTS.map((e) => ours(settingsOf(home), e).length), EVENTS.map(() => 1));
  check("second run: no second backup", backupsIn(home).length, 1);
  check("second run: the token is still there, mode 600", [readFileSync(join(home, ".config/tasks/token"), "utf8"), mode(join(home, ".config/tasks/token"))], [GOOD + "\n", "600"]);
  check("second run: says the hooks are already there", again.out.includes("already there"));
}

// Hooks someone added by hand, pointing at a checkout, count as ours: nothing is duplicated.
{
  const home = newHome();
  const byHand = { hooks: Object.fromEntries(EVENTS.map((e) => [e, [{ hooks: [{ type: "command", command: "node ~/code/todo-agent/scripts/tasks-presence.mjs" }] }]])) };
  const original = JSON.stringify(byHand);
  writeSettings(home, original);
  const r = await run(home, { token: GOOD });
  check("hand-added hooks: exits 0", r.code, 0);
  check("hand-added hooks: settings.json isn't rewritten", readFileSync(settingsPath(home), "utf8"), original);
  check("hand-added hooks: no backup", backupsIn(home), []);
}

// A token file left world-readable is tightened, and a symlinked settings.json stays a symlink.
{
  const home = newHome();
  mkdirSync(join(home, ".config/tasks"), { recursive: true });
  writeFileSync(join(home, ".config/tasks/token"), GOOD + "\n", { mode: 0o644 });
  mkdirSync(join(home, "dotfiles"));
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, "dotfiles/settings.json"), `{"model":"opus"}\n`, { mode: 0o600 });
  symlinkSync(join(home, "dotfiles/settings.json"), settingsPath(home));
  const r = await run(home);
  check("saved token: exits 0", r.code, 0);
  check("saved token: a 644 token file becomes 600", mode(join(home, ".config/tasks/token")), "600");
  check("symlinked settings: still a symlink", lstatSync(settingsPath(home)).isSymbolicLink());
  check("symlinked settings: the real file got the hooks and kept its setting", [settingsOf(home).model, Object.keys(settingsOf(home).hooks).length], ["opus", 7]);
  check("symlinked settings: the real file keeps its mode", mode(join(home, "dotfiles/settings.json")), "600");
  const saved = readdirSync(join(home, "dotfiles")).filter((f) => f.includes(".tasks-backup-"));
  check("symlinked settings: the printed backup path is the backup beside the real file", printedBackup(r.out, home), saved.length === 1 ? realpathSync(join(home, "dotfiles", saved[0])) : "one backup in dotfiles");
}

// A settings.json that lives outside the home folder: the backup's path is printed in full, not with a ~ in the middle.
{
  const home = newHome();
  const elsewhere = newHome();
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(elsewhere, "settings.json"), "{}\n");
  symlinkSync(join(elsewhere, "settings.json"), settingsPath(home));
  const r = await run(home, { token: GOOD });
  const saved = readdirSync(elsewhere).filter((f) => f.includes(".tasks-backup-"));
  check("settings outside home: exits 0", r.code, 0);
  check("settings outside home: the printed backup path is a file that exists", printedBackup(r.out, home), saved.length === 1 ? realpathSync(join(elsewhere, saved[0])) : "one backup beside the real file");
  check("settings outside home: no ~ in the printed backup path", /^saved \/[^~]*$/m.test(r.out));
}

// Things that stop it, each before anything is written.
const untouched = (home) => !existsSync(join(home, ".config")) && backupsIn(home).length === 0;
{
  const home = newHome();
  const broken = `{ "model": "opus", // my favorite\n}`;
  writeSettings(home, broken);
  const r = await run(home, { token: GOOD });
  check("broken settings.json: exits 1", r.code, 1);
  check("broken settings.json: says nothing was changed", r.out.includes("Nothing was changed"));
  check("broken settings.json: left as it was, nothing installed", [readFileSync(settingsPath(home), "utf8"), untouched(home)], [broken, true]);
}
{
  const home = newHome();
  const r = await run(home, { token: "tasks_revoked_0123456789" });
  check("refused token: exits 1", r.code, 1);
  check("refused token: nothing installed", untouched(home) && !existsSync(settingsPath(home)));
}
{
  const home = newHome();
  const r = await run(home, { token: "<YOUR_TOKEN>" });
  check("placeholder token: exits 1", r.code, 1);
  check("placeholder token: nothing installed", untouched(home) && !existsSync(settingsPath(home)));
  const none = await run(newHome());
  check("no token at all: exits 1", none.code, 1);
}

// --dry-run on the hosted origin: says what it would do, writes nothing, and asks the server nothing.
{
  const home = newHome();
  const asked = requests.length;
  const r = await run(home, { token: GOOD, script: buildSetup(installer, files, "https://askscottpierce.com"), args: ["--dry-run"] });
  check("dry run: exits 0", r.code, 0);
  check("dry run: nothing installed", untouched(home) && !existsSync(settingsPath(home)));
  check("dry run: the hosted hook command has no URL in it", r.out.includes("each one runs: node ~/.config/tasks/tasks-presence.mjs\n"));
  check("dry run: no request was made", requests.length, asked);
}

check("the token never appears in a URL", requests.some((u) => u.includes("tasks_")), false);
check("every request went to the presence endpoint", [...new Set(requests)], ["/tasks/api/presence"]);
check("the served file holds both scripts and its origin", served.includes("TASKS_SETUP_EMBEDDED") === false && served.includes(JSON.stringify(origin)));

server.close();
for (const home of homes) rmSync(home, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
