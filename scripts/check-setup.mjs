#!/usr/bin/env node
// Check the one-command event feed setup (scripts/tasks-setup.mjs) the way people run it: the
// file the Worker serves (src/setup.ts), piped into `node --input-type=module -`, against a
// throwaway HOME and a stand-in server on localhost. It never touches the real ~/.claude or
// ~/.config. Most of it is about machines that still have the old Sessions hooks: the installer
// has to take those out of settings.json and leave everything else as it was.
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
const files = { "tasks-events.mjs": read("tasks-events.mjs") };

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
// What the old installer added: one hook on each of these, the two busy ones in the background.
const EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "PermissionRequest", "Notification", "Stop", "SessionEnd"];
const ASYNC = ["UserPromptSubmit", "PostToolUse"];
const OLD_COMMAND = "node ~/.config/tasks/tasks-presence.mjs";
const oldGroup = (event, command = OLD_COMMAND) => ({ hooks: [{ type: "command", command, ...(ASYNC.includes(event) ? { async: true } : {}) }] });
const mentionsOld = (home) => /tasks-presence\.mjs|\/tasks\/api\/presence/.test(readFileSync(settingsPath(home), "utf8"));
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

// 1. A machine with no settings.json: the feed is installed and Claude Code's settings aren't touched.
{
  const home = newHome();
  const r = await run(home, { token: GOOD });
  check("fresh machine: exits 0", r.code, 0);
  check("fresh machine: the token file holds the token", readFileSync(join(home, ".config/tasks/token"), "utf8"), GOOD + "\n");
  check("fresh machine: the token file is mode 600", mode(join(home, ".config/tasks/token")), "600");
  check("fresh machine: tasks-events.mjs is the repo's", readFileSync(join(home, ".config/tasks/tasks-events.mjs"), "utf8") === files["tasks-events.mjs"]);
  check("fresh machine: the feed script is the only script installed", readdirSync(join(home, ".config/tasks")).sort(), ["tasks-events.mjs", "token"]);
  check("fresh machine: no settings.json is made", existsSync(settingsPath(home)), false);
  check("fresh machine: no backup, there was nothing to back up", backupsIn(home), []);
  check("fresh machine: the token isn't printed", r.out.includes(GOOD), false);
  check("fresh machine: nothing is said about hooks", /hook/i.test(r.out), false);
}

// 2. A machine the old installer set up, with other hooks and settings of its own, then 3. the same command again.
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
  // What the old installer left: its hook after any that were already on the event, new events at the end.
  const installed = { ...mine, hooks: { ...mine.hooks } };
  for (const e of EVENTS) installed.hooks[e] = [...(installed.hooks[e] ?? []), oldGroup(e)];
  // Tabs, so the backup can be told from a rewrite.
  const original = JSON.stringify(installed, null, "\t") + "\n";
  writeSettings(home, original);
  mkdirSync(join(home, ".config/tasks"), { recursive: true });
  writeFileSync(join(home, ".config/tasks/tasks-presence.mjs"), "// the old hook script\n");
  const r = await run(home, { token: GOOD });
  check("old install: exits 0", r.code, 0);
  const s = settingsOf(home);
  check("old install: the seven Sessions hooks are gone, and every other hook and setting is as it was", s, mine);
  check("old install: top-level keys and their order are kept", Object.keys(s), Object.keys(mine));
  check("old install: the hook events left are the person's own, in order", Object.keys(s.hooks), Object.keys(mine.hooks));
  check("old install: nothing in the file names the old script", mentionsOld(home), false);
  check("old install: one backup", backupsIn(home).length, 1);
  check("old install: the backup is the old file, byte for byte", readFileSync(join(home, ".claude", backupsIn(home)[0]), "utf8"), original);
  // The temp HOME is under /var on a Mac, which is really /private/var: the path once printed as "/private~/.claude/…".
  check("old install: the printed backup path is a file that exists", printedBackup(r.out, home), realpathSync(join(home, ".claude", backupsIn(home)[0])));
  check("old install: the backup is printed with ~ for home", /^saved ~\/\.claude\/settings\.json\.tasks-backup-\d{14}$/m.test(r.out));
  check("old install: it says which hooks it took out", (/took out the old Sessions hooks \((.+)\)$/m.exec(r.out)?.[1] ?? "").split(", ").sort(), [...EVENTS].sort());
  check("old install: the old script file is left where it is, and it says so", [existsSync(join(home, ".config/tasks/tasks-presence.mjs")), /^left  ~\/\.config\/tasks\/tasks-presence\.mjs/m.test(r.out)], [true, true]);
  check("old install: the feed script is installed", readFileSync(join(home, ".config/tasks/tasks-events.mjs"), "utf8") === files["tasks-events.mjs"]);

  const afterFirst = readFileSync(settingsPath(home), "utf8");
  const again = await run(home); // no TASKS_TOKEN: it uses the one it saved
  check("second run: exits 0 without TASKS_TOKEN", again.code, 0);
  check("second run: settings.json is byte for byte the same", readFileSync(settingsPath(home), "utf8"), afterFirst);
  check("second run: no second backup", backupsIn(home).length, 1);
  check("second run: the token is still there, mode 600", [readFileSync(join(home, ".config/tasks/token"), "utf8"), mode(join(home, ".config/tasks/token"))], [GOOD + "\n", "600"]);
  check("second run: says nothing was taken out", again.out.includes("took out"), false);
}

// A machine whose settings.json the old installer made from nothing: with the hooks gone there's nothing left in it.
{
  const home = newHome();
  writeSettings(home, JSON.stringify({ hooks: Object.fromEntries(EVENTS.map((e) => [e, [oldGroup(e, `TASKS_PRESENCE_URL=${origin}/tasks/api/presence ${OLD_COMMAND}`)]])) }, null, 2) + "\n");
  const r = await run(home, { token: GOOD });
  check("only our hooks: exits 0", r.code, 0);
  check("only our hooks: settings.json is left an empty object", settingsOf(home), {});
  check("only our hooks: one backup", backupsIn(home).length, 1);
}

// Hooks added by hand count too: pointing at a checkout, of type "http", or sharing a group with someone else's hook.
{
  const home = newHome();
  const byHand = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "node ~/code/todo-agent/scripts/tasks-presence.mjs" }] }],
      PreToolUse: [{ hooks: [{ type: "http", url: "https://askscottpierce.com/tasks/api/presence", timeout: 5, headers: { Authorization: "Bearer $TASKS_TOKEN" } }] }],
      PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "npx prettier --write" }, { type: "command", command: OLD_COMMAND, async: true }] }],
      Stop: [{ hooks: [{ type: "http", url: "https://example.com/hook" }] }],
    },
  };
  writeSettings(home, JSON.stringify(byHand));
  const r = await run(home, { token: GOOD });
  check("hand-added hooks: exits 0", r.code, 0);
  check("hand-added hooks: ours are gone from every event, and a hook beside one of ours keeps its group and matcher", settingsOf(home), {
    hooks: {
      PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "npx prettier --write" }] }],
      Stop: [{ hooks: [{ type: "http", url: "https://example.com/hook" }] }],
    },
  });
  check("hand-added hooks: one backup", backupsIn(home).length, 1);
}

// A settings.json with none of the old hooks isn't touched, whatever shape it's in.
{
  const home = newHome();
  const original = JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }, null, "\t") + "\n";
  writeSettings(home, original);
  const r = await run(home, { token: GOOD });
  check("no old hooks: exits 0", r.code, 0);
  check("no old hooks: settings.json is byte for byte the same", readFileSync(settingsPath(home), "utf8"), original);
  check("no old hooks: no backup", backupsIn(home), []);

  const odd = newHome();
  const broken = `{ "model": "opus", // my favorite\n}`;
  writeSettings(odd, broken);
  const r2 = await run(odd, { token: GOOD });
  check("a settings.json that isn't JSON and has no old hooks: the feed still installs", [r2.code, existsSync(join(odd, ".config/tasks/tasks-events.mjs"))], [0, true]);
  check("and the file is left as it was", [readFileSync(settingsPath(odd), "utf8"), backupsIn(odd)], [broken, []]);
}

// A token file left world-readable is tightened, and a symlinked settings.json stays a symlink.
{
  const home = newHome();
  mkdirSync(join(home, ".config/tasks"), { recursive: true });
  writeFileSync(join(home, ".config/tasks/token"), GOOD + "\n", { mode: 0o644 });
  mkdirSync(join(home, "dotfiles"));
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, "dotfiles/settings.json"), JSON.stringify({ model: "opus", hooks: Object.fromEntries(EVENTS.map((e) => [e, [oldGroup(e)]])) }) + "\n", { mode: 0o600 });
  symlinkSync(join(home, "dotfiles/settings.json"), settingsPath(home));
  const r = await run(home);
  check("saved token: exits 0", r.code, 0);
  check("saved token: a 644 token file becomes 600", mode(join(home, ".config/tasks/token")), "600");
  check("symlinked settings: still a symlink", lstatSync(settingsPath(home)).isSymbolicLink());
  check("symlinked settings: the real file lost the hooks and kept its setting", settingsOf(home), { model: "opus" });
  check("symlinked settings: the real file keeps its mode", mode(join(home, "dotfiles/settings.json")), "600");
  const saved = readdirSync(join(home, "dotfiles")).filter((f) => f.includes(".tasks-backup-"));
  check("symlinked settings: the printed backup path is the backup beside the real file", printedBackup(r.out, home), saved.length === 1 ? realpathSync(join(home, "dotfiles", saved[0])) : "one backup in dotfiles");
}

// A settings.json that lives outside the home folder: the backup's path is printed in full, not with a ~ in the middle.
{
  const home = newHome();
  const elsewhere = newHome();
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(elsewhere, "settings.json"), JSON.stringify({ hooks: { Stop: [oldGroup("Stop")] } }) + "\n");
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
  // It has the old hooks in it and can't be parsed, so they can't be taken out safely.
  const broken = `{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "${OLD_COMMAND}" }] }] }, // old\n}`;
  writeSettings(home, broken);
  const r = await run(home, { token: GOOD });
  check("broken settings.json with the old hooks in it: exits 1", r.code, 1);
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
  const original = JSON.stringify({ hooks: { Stop: [oldGroup("Stop")], SessionEnd: [oldGroup("SessionEnd")] } });
  writeSettings(home, original);
  const asked = requests.length;
  const r = await run(home, { token: GOOD, script: buildSetup(installer, files, "https://askscottpierce.com"), args: ["--dry-run"] });
  check("dry run: exits 0", r.code, 0);
  check("dry run: nothing installed, settings.json as it was", [untouched(home), readFileSync(settingsPath(home), "utf8")], [true, original]);
  check("dry run: names the hooks it would take out", r.out.includes("take the old Sessions hooks out of ~/.claude/settings.json, after saving a backup beside it: Stop, SessionEnd\n"));
  check("dry run: no request was made", requests.length, asked);
}

check("the token never appears in a URL", requests.some((u) => u.includes("tasks_")), false);
check("every request went to the one address that checks a token", [...new Set(requests)], ["/tasks/api/presence"]);
check("the served file holds the feed script and its origin, and not the old hook script", [served.includes("TASKS_SETUP_EMBEDDED"), served.includes(JSON.stringify(origin)), served.includes(JSON.stringify(files["tasks-events.mjs"]).slice(0, 200)), served.includes("Tell Tasks this Claude Code session is alive")], [false, true, true, false]);

server.close();
for (const home of homes) rmSync(home, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
