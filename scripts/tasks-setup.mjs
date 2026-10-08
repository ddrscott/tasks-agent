#!/usr/bin/env node
// Set this machine up for the Tasks event feed, in one command. The Connect page
// (/tasks/connect#events) shows it with your token filled in:
//
//   curl -fsSL https://askscottpierce.com/tasks/setup.mjs | TASKS_TOKEN='tasks_…' node --input-type=module -
//
// What it changes, and nothing else:
//
//   ~/.config/tasks/token             your token, mode 600
//   ~/.config/tasks/tasks-events.mjs  the event feed script
//   ~/.claude/settings.json           only if it still has the old Sessions hooks: they're taken
//                                     out, after a backup is saved beside it
//
// Tasks used to list Claude Code sessions, fed by seven hooks this script added. That's gone, so
// a machine set up back then gets them removed: every hook that runs tasks-presence.mjs, from any
// path, and every hook of type "http" that posts to /tasks/api/presence. Every other hook and
// setting is kept, in its order. A settings.json with none of those hooks isn't read past
// looking for them, and running this again changes nothing.
// Add --dry-run to see what it would do without writing anything or contacting the server.
//
// Before it writes, it sends the token once to Tasks (in the Authorization header, never in a
// URL) to make sure it's good. A refused token stops the install; no network doesn't.
//
// Token: TASKS_TOKEN, or the one already in ~/.config/tasks/token. Needs Node 22 or later and
// nothing else. From a checkout, `node scripts/tasks-setup.mjs` installs the script sitting
// next to it.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

// The Worker swaps this line for the script and its own origin when it serves the file
// (src/setup.ts), so one download holds everything that gets installed.
const EMBEDDED = null; // @@TASKS_SETUP_EMBEDDED@@

const HOSTED = "https://askscottpierce.com";
const SCRIPTS = ["tasks-events.mjs"];
// The script the old hooks ran, and the address hooks of type "http" posted to.
const OLD_SCRIPT = "tasks-presence.mjs";
const OLD_ENDPOINT = "/tasks/api/presence";

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

/** Whether one hook entry is an old Sessions hook: it runs the old script, or posts to the old address. */
const isOldHook = (h) => isObject(h)
  && ((typeof h.command === "string" && h.command.includes(OLD_SCRIPT)) || (typeof h.url === "string" && h.url.includes(OLD_ENDPOINT)));

/**
 * settings.json with the old Sessions hooks taken out. Everything else is kept, in its order. A
 * group left with no hooks goes, and so does an event left with no groups, and `hooks` itself
 * if that empties it: those were only there for the hooks being removed. Anything that isn't
 * shaped like Claude Code's hooks is passed through untouched.
 */
function withoutOldHooks(settings) {
  if (!isObject(settings.hooks)) return { settings, removed: [] };
  const hooks = {};
  const removed = [];
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue; }
    const kept = [];
    let hit = false;
    for (const g of groups) {
      if (!isObject(g) || !Array.isArray(g.hooks) || !g.hooks.some(isOldHook)) { kept.push(g); continue; }
      hit = true;
      const rest = g.hooks.filter((h) => !isOldHook(h));
      if (rest.length) kept.push({ ...g, hooks: rest });
    }
    if (hit) removed.push(event);
    if (kept.length || !hit) hooks[event] = kept;
  }
  if (!removed.length) return { settings, removed };
  const { hooks: _, ...others } = settings;
  if (!Object.keys(hooks).length) return { settings: others, removed };
  // Rebuilt key by key so `hooks` stays where it was among the other settings.
  return { settings: Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, k === "hooks" ? hooks : v])), removed };
}

/** Ask the server whether it knows this token. true, false (refused), or null when it can't be reached. */
async function tokenWorks(origin, token) {
  try {
    const r = await fetch(`${origin}/tasks/api/presence`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{}", // this address only says whether the token is good; nothing is stored
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

  // Read settings.json before anything is written, so a file that can't be cleaned stops the whole install.
  // A symlinked settings.json (dotfile managers do this) is edited where it really lives.
  const settingsPath = existsSync(settingsLink) ? realpathSync(settingsLink) : settingsLink;
  const before = readOr(settingsPath);
  let cleaned = { settings: {}, removed: [] };
  // A file that never mentions the old hooks is left alone, valid JSON or not.
  if (before !== null && (before.includes(OLD_SCRIPT) || before.includes(OLD_ENDPOINT))) {
    let settings;
    try { settings = JSON.parse(before); } catch (e) { stop(`${show(settingsLink)} isn't valid JSON (${e.message}). It still has the old Sessions hooks in it: fix the file and run this again, or take out the hooks that run ${OLD_SCRIPT} by hand.`); }
    if (!isObject(settings)) stop(`${show(settingsLink)} isn't a JSON object.`);
    cleaned = withoutOldHooks(settings);
  }
  const files = scriptFiles();
  const oldScript = join(dir, OLD_SCRIPT);

  if (dryRun) {
    say("Dry run. This would:");
    say(`  ${given && given !== saved ? "write" : "keep"} the token in ${show(tokenPath)} (mode 600)`);
    for (const name of SCRIPTS) say(`  ${readOr(join(dir, name)) === files[name] ? "keep" : "write"} ${show(join(dir, name))}`);
    if (cleaned.removed.length) {
      say(`  take the old Sessions hooks out of ${show(settingsLink)}, after saving a backup beside it: ${cleaned.removed.join(", ")}`);
    } else {
      say(`  leave ${show(settingsLink)} alone${before === null ? ": there isn't one" : ": it has no Sessions hooks"}`);
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

  if (cleaned.removed.length) {
    const mode = statSync(settingsPath).mode & 0o777;
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const backup = `${settingsPath}.tasks-backup-${stamp}`;
    copyFileSync(settingsPath, backup);
    say(`saved ${show(backup)}`);
    // Written beside the file and renamed over it, so a crash can't leave half a settings.json.
    const tmp = `${settingsPath}.tasks-tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(cleaned.settings, null, 2) + "\n", { mode });
    renameSync(tmp, settingsPath);
    say(`wrote ${show(settingsLink)}: took out the old Sessions hooks (${cleaned.removed.join(", ")})`);
    say("      Tasks no longer lists Claude Code sessions, so those hooks had nothing left to report to.");
  }
  // Left where it is: a project's own .claude/settings.json may still run it, and a hook whose
  // script is missing shows an error in Claude Code. It still gets a quiet answer from the server.
  if (existsSync(oldScript)) say(`left  ${show(oldScript)}: no hook in ${show(settingsLink)} runs it now, so delete it when you like`);

  say();
  if (works === null) say(`Couldn't reach ${origin} to check the token, so that's untested.`);
  say(`Done. The event feed is installed. It runs only when you ask: tell Claude Code to use the event feed (${origin}/tasks/connect#events).`);
}

// Nothing runs until the whole file has arrived: a download cut off partway never reaches this line.
await main();
