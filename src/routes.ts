// The pages under /tasks/, in one place for the client (which page to draw) and the Worker
// (which addresses are real, so anything else can answer 404). Add a new page here, and give it
// a row in PAGE_META below: the client's tab title and the tags the Worker writes into each
// page's HTML both come from that row.

/** `/tasks/` itself is the board, or the landing page when signed out. These are the rest. */
export const PAGES = ["connect", "privacy", "terms", "demo", "pricing", "invite", "admin"] as const;
export type Page = "board" | (typeof PAGES)[number];

/** The page a path names, or null when there's no such page. `base` is "/tasks". */
export function pageAt(pathname: string, base: string): Page | null {
  if (pathname !== base && !pathname.startsWith(`${base}/`)) return null;
  const sub = pathname.slice(base.length).replace(/\/+$/, "").slice(1);
  if (sub === "") return "board";
  return (PAGES as readonly string[]).includes(sub) ? (sub as Page) : null;
}

// ── What each page calls itself ──────────────────────────────────────────────────────────────
// Link previews (Slack, X, iMessage, Hacker News) read a page's raw HTML and never run its
// JavaScript, so the Worker writes each page's own title, description, and address into the HTML
// it sends (pageHead in src/server.ts). The tab title the client sets comes from the same rows
// (useTitle in src/client/title.ts), so the two can't drift apart.

/** Where the app lives in production. Canonical and og:url point here whatever host served the page. */
export const SITE = "https://askscottpierce.com/tasks";

/** The front page's title, and the tab title before any page sets its own. */
export const DEFAULT_TITLE = "Tasks · A task board your AI agents work over MCP";

/**
 * `name` is the page's short name: "Connect an agent" makes the title "Connect an agent · Tasks".
 * `description` is one or two true sentences about that page. `/tasks/` has neither: signed out
 * it's the front page, whose descriptions and JSON-LD are written out in index.html.
 */
export const PAGE_META = {
  board: { name: "", description: "" },
  connect: {
    name: "Connect an agent",
    description: "Connect Claude Code, Cursor, Codex, or any MCP client to your Tasks board. One command for Claude Code, the steps for the rest, and the hooks that list every session.",
  },
  demo: {
    name: "Demo board",
    description: "A live demo board, no sign-up. Drag cards, answer an agent's question in one tap, and watch a scripted agent pick it up. It runs in your browser tab and nothing is saved.",
  },
  pricing: {
    name: "Pricing",
    description: "What Tasks costs. The board and MCP access are never capped on any plan. Pro raises the daily assistant limit and adds team boards.",
  },
  privacy: {
    name: "Privacy",
    description: "What Tasks keeps and why: your email, your board, the files you attach, and your assistant chat. No ads, no tracking cookies, and your data isn't sold.",
  },
  // Where an invite email's link lands (// TEAM_BOARDS). The token is in the fragment, so every
  // invite is this one address, and it's kept out of search results (pageHead).
  invite: { name: "Board invite", description: "Accept or decline an invite to someone's Tasks board. Sign in as the address it was sent to." },
  // Admins only (src/users.ts). The page is the same HTML as any other, so it's kept out of search instead.
  admin: { name: "Admin", description: "Who can use Tasks, and on what plan." },
  terms: { name: "Terms", description: "The terms of service for Tasks, the task board your AI coding agents work over MCP." },
  notFound: { name: "Not found", description: "There's no page at this address." },
} as const satisfies Record<Page | "notFound", { name: string; description: string }>;

/** The tab title of your own board, signed in. It's never in served HTML: signed out, `/tasks/` is the front page. */
export const BOARD_NAME = "Board";

/** Every name a page may pass to useTitle. A name that isn't in the table doesn't compile. */
export type PageName = Exclude<(typeof PAGE_META)[keyof typeof PAGE_META]["name"], ""> | typeof BOARD_NAME;

/** "Connect an agent · Tasks", or the full default with no name. */
export const titleFor = (name?: string) => (name ? `${name} · Tasks` : DEFAULT_TITLE);

/** What the Worker writes into a page's HTML. `url` is null for an address that names nothing. */
export type PageHead = { title: string; description: string | null; url: string | null; index: boolean; landing: boolean };

/** The head for a page, or for the not-found page when `page` is null. */
export function pageHead(page: Page | null): PageHead {
  if (page === null) return { title: titleFor(PAGE_META.notFound.name), description: PAGE_META.notFound.description, url: null, index: false, landing: false };
  if (page === "board") return { title: DEFAULT_TITLE, description: null, url: `${SITE}/`, index: true, landing: true };
  const m = PAGE_META[page];
  return { title: titleFor(m.name), description: m.description, url: `${SITE}/${page}`, index: page !== "invite" && page !== "admin", landing: false };
}
