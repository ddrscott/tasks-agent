// The pages under /tasks/, in one place for the client (which page to draw) and the Worker
// (which addresses are real, so anything else can answer 404). Add a new page here.

/** `/tasks/` itself is the board, or the landing page when signed out. These are the rest. */
export const PAGES = ["connect", "privacy", "terms", "demo", "pricing"] as const;
export type Page = "board" | (typeof PAGES)[number];

/** The page a path names, or null when there's no such page. `base` is "/tasks". */
export function pageAt(pathname: string, base: string): Page | null {
  if (pathname !== base && !pathname.startsWith(`${base}/`)) return null;
  const sub = pathname.slice(base.length).replace(/\/+$/, "").slice(1);
  if (sub === "") return "board";
  return (PAGES as readonly string[]).includes(sub) ? (sub as Page) : null;
}
