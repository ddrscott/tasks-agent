// "Discard changes?" for the two card dialogs. The X and Esc close an untouched dialog at once.
// Once something was edited they ask first, in a bar where the footer buttons were, so a slip
// of the hand can't throw away what was typed.

import { useRef, useState } from "react";

type DialogProps = Pick<React.ComponentProps<"dialog">, "onCancel" | "onKeyDown" | "onClose">;

export function useDiscardGuard(isDirty: () => boolean, onClose: () => void) {
  const [asking, setAsking] = useState(false);
  // The bar takes focus for its buttons. Keep editing gives it back to the field it came from.
  const was = useRef<HTMLElement | null>(null);
  /** The X: close if nothing changed, otherwise ask. */
  const requestClose = () => {
    if (!isDirty()) return onClose();
    if (!asking) was.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAsking(true);
  };
  const keep = () => { setAsking(false); was.current?.focus(); };
  // Esc while the bar is showing means Keep editing, so mashing Esc never loses work.
  const esc = () => { if (asking) keep(); else requestClose(); };

  const dialogProps: DialogProps = {
    // Esc is handled as a key press, not left to the browser: after one refused close, Chrome
    // closes a dialog on the next Esc without asking the page at all.
    onKeyDown: (e) => { if (e.key === "Escape") { e.preventDefault(); esc(); } },
    // Close requests that aren't a key press here, like Android's back button, or Esc from a
    // field that keeps its key presses to itself.
    onCancel: (e) => { e.preventDefault(); esc(); },
    // If the browser closes the dialog anyway, it's still on the page with the edits in it. Show it again.
    onClose: (e) => { if (!e.currentTarget.open) e.currentTarget.showModal(); },
  };
  return { asking, requestClose, keep, dialogProps };
}

/** Takes the place of the footer's buttons while the question is open. */
export function DiscardBar({ onKeep, onDiscard }: { onKeep(): void; onDiscard(): void }) {
  return (
    <div className="dialog-foot discard-bar" role="group" aria-label="Discard changes?">
      <span className="discard-q">Discard changes?</span>
      <span className="spacer" />
      {/* Focus lands on the safe answer, so Enter keeps the work. */}
      <button type="button" className="btn" autoFocus onClick={onKeep}>Keep editing</button>
      <button type="button" className="btn danger" onClick={onDiscard}>Discard</button>
    </div>
  );
}
