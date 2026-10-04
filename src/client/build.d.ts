// Baked in by vite.config.ts at build time: the released version, the commit, when it was built,
// the newest changelog entries, and how many entries there are.
declare const __BUILD__: {
  version: string | null;
  sha: string;
  builtAt: string;
  changes: { name: string; date: string | null; groups: { kind: string; items: string[] }[] }[];
  /** How many changelog entries didn't fit. */
  more: number;
  /** Changelog entries counted at build time: all of them, the ones under [Unreleased], and the newest release's. */
  counts: { total: number; unreleased: number; latest: { name: string; date: string | null; count: number } | null };
};
