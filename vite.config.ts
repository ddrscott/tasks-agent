import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

type Release = { name: string; date: string | null; groups: { kind: string; items: string[] }[] };

/**
 * What the footer shows (src/client/Footer.tsx): the released version from package.json, the
 * commit this build came from, when it was built, and the newest changes in CHANGELOG.md
 * (Keep a Changelog format). Plus how many entries the changelog holds, for the landing page.
 * Worked out once, when Vite starts.
 */
function buildInfo() {
  let sha = "dev";
  try {
    sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    // Uncommitted changes mean the commit doesn't say what's running.
    if (execSync("git status --porcelain", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim()) sha += "+";
  } catch { /* not a git checkout */ }

  let version: string | null = null;
  try {
    version = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version?: string }).version ?? null;
  } catch { /* no package.json */ }

  // "## [Unreleased]" or "## [1.2.0] - 2026-10-03", then "### Added" groups of "- " lines.
  const releases: Release[] = [];
  try {
    for (const line of readFileSync(new URL("./CHANGELOG.md", import.meta.url), "utf8").split("\n")) {
      const rel = /^##\s+\[([^\]]+)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?/.exec(line);
      const group = /^###\s+(.+?)\s*$/.exec(line);
      const item = /^[-*]\s+(\S.*)$/.exec(line);
      const cur = releases[releases.length - 1];
      if (rel) releases.push({ name: rel[1], date: rel[2] ?? null, groups: [] });
      else if (group && cur) cur.groups.push({ kind: group[1], items: [] });
      else if (item && cur?.groups.length) cur.groups[cur.groups.length - 1].items.push(item[1].trim());
    }
  } catch { /* no changelog */ }

  // The footer has room for the newest few. Entries are appended as work lands, so the newest
  // sit last in each group: show those first, from the newest two releases that have any.
  const MAX_RELEASES = 2, MAX_ITEMS = 14;
  let left = MAX_ITEMS;
  const changes: Release[] = [];
  for (const r of releases) {
    if (changes.length === MAX_RELEASES || left <= 0) break;
    const groups = [];
    for (const g of r.groups) {
      const items = [...g.items].reverse().slice(0, Math.max(left, 0));
      left -= items.length;
      if (items.length) groups.push({ kind: g.kind, items });
    }
    if (groups.length) changes.push({ ...r, groups });
  }
  const size = (r: Release) => r.groups.reduce((m, g) => m + g.items.length, 0);
  const total = releases.reduce((n, r) => n + size(r), 0);
  // What the landing page's // CHECK_IT_YOURSELF quotes: counted here, never typed in.
  const newest = releases.find((r) => /^\d/.test(r.name));
  const counts = {
    total,
    unreleased: releases.filter((r) => !/^\d/.test(r.name)).reduce((n, r) => n + size(r), 0),
    latest: newest ? { name: newest.name, date: newest.date, count: size(newest) } : null,
  };
  return { version, sha, builtAt: new Date().toISOString(), changes, more: Math.max(total - (MAX_ITEMS - Math.max(left, 0)), 0), counts };
}

export default defineConfig({
  // The app is served from /tasks. Emitting assets under tasks/ makes their file
  // paths match their URLs, so the asset layer serves them without the Worker.
  build: { assetsDir: "tasks/assets" },
  define: { __BUILD__: JSON.stringify(buildInfo()) },
  plugins: [
    agents(),
    react(),
    // LOCAL_ONLY=1 skips remote bindings (Workers AI), so the board and login
    // run without a Cloudflare login. The assistant errors in that mode.
    cloudflare({ remoteBindings: process.env.LOCAL_ONLY !== "1" }),
  ],
});
