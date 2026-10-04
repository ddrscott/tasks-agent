// The top bar's width depends on what's going on: open questions, a session count, due stats, and a
// tag filter all add to it, and the assistant panel takes 360px away. A media query can't see any
// of that, so the bar is measured. When the buttons don't fit, it gives up space in this order,
// one step at a time, and stops at the first step that fits:
//
//   search  the search box becomes its icon (it opens across the bar when focused)
//   labels  "Undo", "need you", "Sessions", "Assistant" drop to icon plus count
//   stats   the open / due today / overdue summary goes
//   chip    the tag filter chip moves to its own row under the bar
//   shared  the "Shared with N" button folds into a count on the account button
//   mark    the wordmark goes, when a board switcher sits beside it and a phone still has no room
//
// The steps land in data-tight as a word list, and styles.css does the rest.

const STEPS = ["", "search", "search labels", "search labels stats", "search labels stats chip", "search labels stats chip shared", "search labels stats chip shared mark"];

/** True when the last button's right edge is inside the bar's padding. */
function fits(bar: HTMLElement): boolean {
  const actions = bar.querySelector<HTMLElement>(".actions");
  if (!actions) return true;
  const edge = bar.getBoundingClientRect().right - parseFloat(getComputedStyle(bar).paddingRight);
  return actions.getBoundingClientRect().right <= edge + 0.5;
}

/** Keep `bar` fitted until the returned function is called. Meant for a ref callback. */
export function fitTopbar(bar: HTMLElement | null): (() => void) | undefined {
  if (!bar) return;

  const fit = () => {
    // A collapsed search box that has focus lies over the whole bar, out of the flow, so a
    // measurement taken now would be of a bar with no search box in it. Wait for it to close.
    if (bar.dataset.tight && bar.querySelector(".search:focus-within")) return;
    for (const step of STEPS) {
      if (bar.dataset.tight !== step) bar.dataset.tight = step;
      if (fits(bar)) break;
    }
  };

  fit();
  // The bar's own width changes with the window and the assistant panel; what's in it changes
  // with the board. Both run before the next paint, so a step never shows half applied.
  const resized = new ResizeObserver(fit);
  resized.observe(bar);
  const changed = new MutationObserver(fit);
  changed.observe(bar, { childList: true, subtree: true, characterData: true });
  // Focus has moved on by the next frame, so the search box is back in the flow by then.
  const blurred = () => requestAnimationFrame(fit);
  bar.addEventListener("focusout", blurred);
  // Text is wider or narrower once the web fonts arrive.
  let live = true;
  void document.fonts?.ready.then(() => { if (live) fit(); });

  return () => {
    live = false;
    resized.disconnect();
    changed.disconnect();
    bar.removeEventListener("focusout", blurred);
  };
}
