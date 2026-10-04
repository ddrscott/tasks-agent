#!/usr/bin/env node
// Set this machine up to report its Claude Code sessions to Tasks, in one command. The Connect
// page (/tasks/connect#sessions) shows it with your token filled in:
//
//   curl -fsSL https://askscottpierce.com/tasks/setup.mjs | TASKS_TOKEN='tasks_…' node --input-type=module -
//
// What it changes, and nothing else:
//
//   ~/.config/tasks/token               your token, mode 600
//   ~/.config/tasks/tasks-presence.mjs  the hook script
//   ~/.config/tasks/tasks-events.mjs    the event feed script
//   ~/.claude/settings.json             seven hooks added; a backup is saved beside it first
//
// Every hook and setting already in settings.json is kept. Running it again changes nothing:
// a hook that already runs tasks-presence.mjs is left as it is, wherever that copy lives.
// Add --dry-run to see what it would do without writing anything or contacting the server.
//
// Before it writes, it sends the token once to Tasks (in the Authorization header, never in a
// URL) to make sure it's good. A refused token stops the install; no network doesn't.
//
// Token: TASKS_TOKEN, or the one already in ~/.config/tasks/token. Needs Node 22 or later and
// nothing else. From a checkout, `node scripts/tasks-setup.mjs` installs the two scripts
// sitting next to it.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

// The Worker swaps this line for the two scripts and its own origin when it serves the file
// (src/setup.ts), so one download holds everything that gets installed.
const EMBEDDED = null; // @@TASKS_SETUP_EMBEDDED@@

const HOSTED = "https://askscottpierce.com";
const SCRIPTS = ["tasks-presence.mjs", "tasks-events.mjs"];
// The two events that fire constantly run in the background ("async"). The rest run in line: a
// backgrounded Stop hook is killed when a `claude -p` run exits, leaving the session "working".
const HOOK_EVENTS = [
  ["SessionStart", false], ["UserPromptSubmit", true], ["PostToolUse", true], ["PermissionRequest", false],
  ["Notification", false], ["Stop", false], ["SessionEnd", false],
];

const say = (line = "") => process.stdout.write(line + "\n");
function stop(why) {
  process.stderr.write(`tasks-setup: ${why}\nNothing was changed.\n`);
  process.exit(1);
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const readOr = (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } };
const realOr = (path) => { try { return realpathSync(path); } catch { return path; } };

/** The scripts to install: the ones the Worker put in this file, or the ones next to it in a checkout. */
function scriptFiles() {
  if (EMBEDDED) return EMBEDDED.files;
  const files = {};
  for (const name of SCRIPTS) {
    try { files[name] = readFileSync(new URL(`./${name}`, import.meta.url), "utf8"); }
    catch { stop(`can't find ${name} next to this script. Run the command from the Connect page instead.`); }
  }
  return files;
}

/**
 * settings.json with the seven hooks merged in. Everything already there is kept, in its
 * order. An event that already has a hook running tasks-presence.mjs is left alone.
 */
function withHooks(settings, command) {
  const hooks = { ...(settings.hooks ?? {}) };
  const added = [];
  for (const [event, background] of HOOK_EVENTS) {
    const groups = hooks[event] ?? [];
    const has = groups.some((g) => isObject(g) && Array.isArray(g.hooks)
      && g.hooks.some((h) => isObject(h) && typeof h.command === "string" && h.command.includes("tasks-presence.mjs")));
    if (has) continue;
    hooks[event] = [...groups, { hooks: [{ type: "command", command, ...(background ? { async: true } : {}) }] }];
    added.push(event);
  }
  return { settings: { ...settings, hooks }, added };
}

/** Ask the server whether it knows this token. true, false (refused), or null when it can't be reached. */
async function tokenWorks(origin, token) {
  try {
    const r = await fetch(`${origin}/tasks/api/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{}", // no session id in it, so nothing is stored
      signal: AbortSignal.timeout(5000),
    });
    if (r.status === 401) return false;
    return r.ok ? true : null;
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const unknown = args.find((a) => a !== "--dry-run");
  if (unknown) stop(`unknown argument ${unknown}. The only option is --dry-run.`);
  if (Number(process.versions.node.split(".")[0]) < 22) stop(`this needs Node 22 or later, and this is ${process.versions.node}.`);

  const origin = (process.env.TASKS_ORIGIN ?? EMBEDDED?.origin ?? HOSTED).replace(/\/+$/, "");
  const home = homedir();
  const dir = join(home, ".config", "tasks");
  const tokenPath = join(dir, "token");
  const settingsLink = join(home, ".claude", "settings.json");
  // Paths are printed with ~ for the home folder. A path can name home two ways (on a Mac,
  // /var/… is really /private/var/…), so both are tried, and only at the start of the path.
  // Anything outside home is printed in full.
  const homes = [...new Set([home, realOr(home)])];
  const show = (path) => {
    for (const h of homes) {
      if (path === h) return "~";
      if (path.startsWith(h.endsWith(sep) ? h : h + sep)) return "~" + sep + path.slice(h.length).replace(/^[\\/]+/, "");
    }
    return path;
  };

  // The token: the one handed in, or the one already on this machine.
  const given = (process.env.TASKS_TOKEN ?? "").trim();
  const saved = (readOr(tokenPath) ?? "").split("\n")[0].trim();
  const token = given || saved;
  if (!token) stop(`no token. Create one at ${origin}/tasks/connect and run the command it shows, which sets TASKS_TOKEN.`);
  if (!/^tasks_[^\s'"<>]+$/.test(token)) stop(`that doesn't look like a Tasks token (they start with tasks_). Create one at ${origin}/tasks/connect.`);

  // Read settings.json before anything is written, so a file that can't be merged stops the whole install.
  // A symlinked settings.json (dotfile managers do this) is edited where it really lives.
  const settingsPath = existsSync(settingsLink) ? realpathSync(settingsLink) : settingsLink;
  const before = readOr(settingsPath);
  let settings = {};
  if (before !== null && before.trim()) {
    try { settings = JSON.parse(before); } catch (e) { stop(`${show(settingsLink)} isn't valid JSON (${e.message}). Fix it, or add the hooks by hand from ${origin}/tasks/connect#sessions.`); }
    if (!isObject(settings)) stop(`${show(settingsLink)} isn't a JSON object.`);
    if (settings.hooks !== undefined && !isObject(settings.hooks)) stop(`"hooks" in ${show(settingsLink)} isn't an object.`);
    for (const [event] of HOOK_EVENTS) {
      if (settings.hooks?.[event] !== undefined && !Array.isArray(settings.hooks[event])) stop(`"hooks.${event}" in ${show(settingsLink)} isn't a list.`);
    }
  }
  // Anywhere but the hosted app, the hook has to be told which server to report to.
  const command = `${origin === HOSTED ? "" : `TASKS_PRESENCE_URL=${origin}/tasks/api/presence `}node ~/.config/tasks/tasks-presence.mjs`;
  const merged = withHooks(settings, command);
  const files = scriptFiles();

  if (dryRun) {
    say("Dry run. This would:");
    say(`  ${given && given !== saved ? "write" : "keep"} the token in ${show(tokenPath)} (mode 600)`);
    for (const name of SCRIPTS) say(`  ${readOr(join(dir, name)) === files[name] ? "keep" : "write"} ${show(join(dir, name))}`);
    if (merged.added.length) {
      say(`  add ${merged.added.length} hooks to ${show(settingsLink)}${before === null ? " (new file)" : ", after saving a backup beside it"}: ${merged.added.join(", ")}`);
      say(`  each one runs: ${command}`);
    } else {
      say(`  leave ${show(settingsLink)} alone: the hooks are already there`);
    }
    say("Nothing was changed.");
    return;
  }

  const works = await tokenWorks(origin, token);
  if (works === false) stop(`${origin} refused that token. It may have been revoked or cut short when it was copied. Create a new one at ${origin}/tasks/connect.`);

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (token !== saved) writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
  chmodSync(tokenPath, 0o600); // the mode above only applies to a new file
  say(`${token !== saved ? "wrote" : "kept "} ${show(tokenPath)} (mode 600)`);

  for (const name of SCRIPTS) {
    const path = join(dir, name);
    const same = readOr(path) === files[name];
    if (!same) writeFileSync(path, files[name], { mode: 0o644 });
    say(`${same ? "kept " : "wrote"} ${show(path)}`);
  }

  if (merged.added.length) {
    let mode = 0o644;
    if (before !== null) {
      mode = statSync(settingsPath).mode & 0o777;
      const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
      const backup = `${settingsPath}.tasks-backup-${stamp}`;
      copyFileSync(settingsPath, backup);
      say(`saved ${show(backup)}`);
    }
    mkdirSync(dirname(settingsPath), { recursive: true });
    // Written beside the file and renamed over it, so a crash can't leave half a settings.json.
    const tmp = `${settingsPath}.tasks-tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(merged.settings, null, 2) + "\n", { mode });
    renameSync(tmp, settingsPath);
    say(`wrote ${show(settingsLink)}: added ${merged.added.length} hooks (${merged.added.join(", ")})`);
  } else {
    say(`kept  ${show(settingsLink)}: the hooks are already there`);
  }

  say();
  if (works === null) say(`Couldn't reach ${origin} to check the token, so that's untested.`);
  say(`Done. Start a Claude Code session and it shows up under Sessions on your board within a few seconds.`);
}

// Nothing runs until the whole file has arrived: a download cut off partway never reaches this line.
await main();
