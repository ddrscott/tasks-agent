import { useEffect } from "react";
import { DEFAULT_TITLE, titleFor, type PageName } from "../routes";

/** The tab title before any page sets its own. It lives in src/routes.ts with every page's name. */
export { DEFAULT_TITLE };

/**
 * Names the tab for the page that's showing: `useTitle("Connect an agent")` gives
 * "Connect an agent · Tasks". With no page it's the full default, which is what the sign-in
 * screen uses, since that's the page a shared link lands on. The names come from PAGE_META in
 * src/routes.ts, the same table the Worker writes each page's <title> from, so a name that
 * isn't there doesn't compile.
 */
export function useTitle(page?: PageName) {
  useEffect(() => {
    document.title = titleFor(page);
  }, [page]);
}
