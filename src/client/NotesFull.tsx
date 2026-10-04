// The expander on a card's notes. Notes start a few lines tall and grow with what's in them up
// to a cap, so the lane, due date, tags, and files under them stay in view. This button gives
// the notes the whole dialog instead, and takes it back. The dialog carries the `notes-full`
// class while it's on; styles.css does the rest.
import { IconCollapse, IconExpand } from "./icons";

export function NotesFullButton({ full, onToggle }: { full: boolean; onToggle(): void }) {
  const label = full ? "Shrink notes" : "Expand notes to fill the dialog";
  return (
    <button type="button" className="btn ghost icon notes-full-btn" aria-pressed={full} aria-label={label} title={label} onClick={onToggle}>
      {full ? <IconCollapse /> : <IconExpand />}
    </button>
  );
}
