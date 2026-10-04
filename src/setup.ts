// The one-command Sessions setup, as served at /tasks/setup.mjs. It's scripts/tasks-setup.mjs
// with the two scripts it installs and this server's origin written into it, so the one file
// someone pipes into node is everything that lands on their machine. Nothing is imported here:
// server.ts hands in the script text, and scripts/check-setup.mjs builds the same file to test it.

/** The line in scripts/tasks-setup.mjs that gets swapped out. */
const MARKER = "const EMBEDDED = null; // @@TASKS_SETUP_EMBEDDED@@";

export function buildSetup(installer: string, files: Record<string, string>, origin: string): string {
  if (!installer.includes(MARKER)) throw new Error("tasks-setup.mjs has lost its EMBEDDED line");
  // A function, so a "$" in a script is never read as a replacement pattern.
  return installer.replace(MARKER, () => `const EMBEDDED = ${JSON.stringify({ origin, files })};`);
}
