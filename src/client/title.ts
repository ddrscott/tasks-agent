import { useEffect } from "react";

/** The tab title before any page sets its own. Keep in sync with <title> in index.html. */
export const DEFAULT_TITLE = "Tasks · A task board your AI agents work over MCP";

/**
 * Names the tab for the page that's showing: `useTitle("Connect an agent")` gives
 * "Connect an agent · Tasks". With no page it's the full default, which is what the sign-in
 * screen uses, since that's the page a shared link lands on.
 */
export function useTitle(page?: string) {
  useEffect(() => {
    document.title = page ? `${page} · Tasks` : DEFAULT_TITLE;
  }, [page]);
}
