// Text someone typed on a shared board and couldn't save, kept where they can copy it
// (// TEAM_BOARDS in the README). A writer can be made a viewer, or removed, between one
// keystroke and the next. Whatever they were typing, in the card editor, the New card dialog,
// or a lane's "Add a card" box, mustn't just vanish.
//
// One mechanism, two halves:
// - Every place that takes typing reports what's in it and not saved (`useDraft`). The board's
//   Workspace holds the list (`DraftsContext`).
// - Made a viewer: the place itself turns read only and shows its own text under "Not saved."
//   (`Unsaved`). Removed: the whole board closes, so the Workspace hands the list to whatever
//   opens next, and the member's own board shows it (`KeptNotice`).

import { createContext, useContext, useEffect } from "react";

/** What was typed and not saved, by field. `lines` is a lane's "Add a card" box: one card per line. */
export type Draft = { title?: string; notes?: string; tags?: string; lines?: string };
/** A draft and where it was typed, for showing it somewhere else. */
export type Kept = Draft & { where: string };

export const hasDraft = (d: Draft | null | undefined): d is Draft =>
  !!d && [d.title, d.notes, d.tags, d.lines].some((v) => typeof v === "string" && v.trim() !== "");

/** Where each open editor says what it's holding. Null outside a board that keeps the list (the demo). */
export const DraftsContext = createContext<{ report(key: string, kept: Kept | null): void } | null>(null);

/** Keep the board's list current with what this editor holds: `kept`, or null for nothing to lose. Cleared when the editor goes away. */
export function useDraft(key: string, kept: Kept | null) {
  const drafts = useContext(DraftsContext);
  useEffect(() => { drafts?.report(key, kept && hasDraft(kept) ? kept : null); });
  useEffect(() => () => drafts?.report(key, null), [drafts, key]);
}

/** The typed text itself: read only, selectable, one box per field. */
export function UnsavedFields({ draft }: { draft: Draft }) {
  const rows = (s: string, most: number) => Math.min(most, s.split("\n").length + 1);
  return (
    <>
      {draft.title !== undefined && <label>Title you typed<textarea className="field" readOnly rows={1} value={draft.title} onFocus={(e) => e.target.select()} /></label>}
      {draft.notes !== undefined && <label>Notes you typed<textarea className="field" readOnly rows={rows(draft.notes, 8)} value={draft.notes} /></label>}
      {draft.tags !== undefined && <label>Tags you typed<input className="field" readOnly value={draft.tags} /></label>}
      {draft.lines !== undefined && <label>Cards you typed, one per line<textarea className="field" readOnly rows={rows(draft.lines, 8)} value={draft.lines} onFocus={(e) => e.target.select()} /></label>}
    </>
  );
}

/** "Not saved.", why, and the text. `after` says what throws it away. */
export function Unsaved({ draft, why, after = "Closing this card throws it away." }: { draft: Draft; why: string; after?: string }) {
  return (
    <div className="unsaved" role="alert">
      <p><b>Not saved.</b> {why} What you typed is below, so you can copy it. {after}</p>
      <UnsavedFields draft={draft} />
    </div>
  );
}

/** On your own board, after a shared one closed under you: why it closed, and everything you'd typed there. It stays until dismissed. */
export function KeptNotice({ why, kept, onDismiss }: { why: string; kept: Kept[]; onDismiss(): void }) {
  return (
    <aside className="kept-note" role="alert" aria-label="Text that wasn't saved">
      <div className="kept-head">
        <h2 className="h">NOT_SAVED</h2>
        <button type="button" className="btn" onClick={onDismiss}>Dismiss</button>
      </div>
      <p>{why} What you were typing there wasn't saved. It's below, so you can copy it. Dismiss throws it away.</p>
      {kept.map((k, i) => (
        <div key={i} className="unsaved">
          <p><b>{k.where}</b></p>
          <UnsavedFields draft={k} />
        </div>
      ))}
    </aside>
  );
}
