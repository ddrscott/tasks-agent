// Baked in by vite.config.ts at build time: the released version, the commit, when it was built,
// and the newest changelog entries.
declare const __BUILD__: {
  version: string | null;
  sha: string;
  builtAt: string;
  changes: { name: string; date: string | null; groups: { kind: string; items: string[] }[] }[];
  /** How many changelog entries didn't fit. */
  more: number;
};
