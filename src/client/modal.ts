// What the three modal dialogs share (the card editor, New card, Encryption). Each is a native
// <dialog> opened with showModal(), which is what keeps Tab inside it: the browser makes the
// rest of the page inert. The browser also hands focus back when a dialog is closed, but these
// are taken off the page by React instead, and a removed dialog leaves focus on <body>. So the
// hook remembers what had focus when the dialog opened and gives it back when the dialog goes.

import { useEffect, type RefObject } from "react";

/** Spread on the <dialog>. A native modal dialog already has these, said out loud for tools that look for the attributes. */
export const MODAL = { role: "dialog", "aria-modal": true } as const;

type Options = {
  /** Where focus lands once it's open. Without it the browser picks: the first control. */
  focus?(dialog: HTMLDialogElement): void;
  /** What to focus on close when the opener is gone, like a card that was redrawn in another lane. */
  fallback?(): HTMLElement | null;
};

export function useModal(ref: RefObject<HTMLDialogElement | null>, { focus, fallback }: Options = {}) {
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    dialog.showModal();
    focus?.(dialog);
    return () => {
      const back = () => {
        // Another dialog opened in the meantime (the editor redrawn for an agent's change): it keeps focus.
        if (document.querySelector("dialog[open]")) return;
        // Focus is already somewhere real, so leave it there.
        if (document.activeElement && document.activeElement !== document.body) return;
        (opener?.isConnected ? opener : fallback?.())?.focus({ preventScroll: true });
      };
      back();
      // Closing often comes with a change to the board (Mark done, a move), and the board redraws
      // a moment later. A card that's redrawn in another lane takes the focus it was just given
      // with it, so look again once that's had time to happen.
      requestAnimationFrame(back);
      setTimeout(back, 150);
      setTimeout(back, 500);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
