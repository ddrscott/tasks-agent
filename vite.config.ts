import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

/**
 * What the footer shows (src/client/Footer.tsx): the commit this build came from, when it was
 * built, and the newest days of CHANGELOG.md. Worked out once, when Vite starts.
 */
function buildInfo() {
  let sha = "dev";
  try {
    sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    // Uncommitted changes mean the commit doesn't say what's running.
    if (execSync("git status --porcelain", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim()) sha += "+";
  } catch { /* not a git checkout */ }
  const changes: { date: string; items: string[] }[] = [];
  try {
    for (const line of readFileSync(new URL("./CHANGELOG.md", import.meta.url), "utf8").split("\n")) {
      const day = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/.exec(line);
      if (day) changes.push({ date: day[1], items: [] });
      else if (changes.length && /^[-*]\s+\S/.test(line)) changes[changes.length - 1].items.push(line.replace(/^[-*]\s+/, "").trim());
    }
  } catch { /* no changelog */ }
  const MAX_DAYS = 3, MAX_ITEMS = 12;
  const recent = changes.filter((c) => c.items.length).slice(0, MAX_DAYS);
  let left = MAX_ITEMS;
  for (const c of recent) { c.items = c.items.slice(0, Math.max(left, 0)); left -= c.items.length; }
  return { sha, builtAt: new Date().toISOString(), changes: recent.filter((c) => c.items.length) };
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
