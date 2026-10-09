// Name a board: a new one, or a new name for the one on screen (// BOARDS in the README). It's
// a modal like the card editor (useModal), one field and two buttons, and it stays open with
// the server's sentence when the server says no (a free plan, the board limit, a bad name).

import { useRef, useState, type FormEvent } from "react";
import { MODAL, useModal } from "./modal";

export const BOARD_NAME_MAX = 60;

type Props = {
  /** "new" makes a board; "rename" renames the one on screen, whose current name is `name`. */
  mode: "new" | "rename";
  name?: string;
  /** Resolves when it's done; rejects with the sentence to show. */
  onSubmit(name: string): Promise<void>;
  onClose(): void;
};

export function BoardDialog({ mode, name = "", onSubmit, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useModal(ref, { focus: () => input.current?.select() });
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = mode === "new" ? "NEW_BOARD" : "RENAME_BOARD";
  const verb = mode === "new" ? "Create" : "Rename";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next = draft.trim();
    if (!next || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(next);
    } catch (err) {
      setError((err as Error).message || "That didn't work. Try again in a minute.");
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} {...MODAL} aria-label={mode === "new" ? "New board" : "Rename board"} className="board-dialog" onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <form onSubmit={submit}>
        <div className="dialog-body">
          <h2 className="h">{title}</h2>
          <label>
            <span>Name</span>
            <input
              ref={input} className="field" value={draft} maxLength={BOARD_NAME_MAX} autoComplete="off" spellCheck={false}
              placeholder={mode === "new" ? "Shop API, Book launch, Home…" : undefined}
              onChange={(e) => { setDraft(e.target.value); setError(null); }}
            />
          </label>
          {mode === "new" && <p>A board is a project: its own cards, members, and later its own pages and files. Your agents reach every board you own.</p>}
          {error && <p className="mem-error" role="alert">{error}</p>}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !draft.trim() || (mode === "rename" && draft.trim() === name)}>{busy ? `${verb}…` : verb}</button>
        </div>
      </form>
    </dialog>
  );
}
