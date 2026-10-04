// The full dialog for a new card, opened by the + in a lane's header: title, notes, lane, due
// date, and tags in one go. Nothing is added until Add card, so backing out leaves no empty card.
// The "Add a card" row at the bottom of a lane is still the quick way to type one title or paste a list.

import { useEffect, useRef, useState } from "react";
import { cleanTag, type Lane } from "../shared";
import { IconClose, IconPlus } from "./icons";

export type NewCardInput = { laneId: string; title: string; notes: string; due: string | null; tags: string[] };

type Props = {
  lanes: Lane[];
  /** The lane whose + was clicked. */
  laneId: string;
  onAdd(input: NewCardInput): Promise<unknown>;
  onClose(): void;
};

export function NewCard({ lanes, laneId, onAdd, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [lane, setLane] = useState(laneId);
  const [due, setDue] = useState("");
  const [tags, setTags] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const dirty = !!(title.trim() || notes.trim() || due || tags.trim());

  async function add() {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      await onAdd({
        laneId: lanes.some((l) => l.id === lane) ? lane : laneId,
        title, notes, due: due || null,
        tags: [...new Set(tags.split(/[\s,]+/).map(cleanTag).filter(Boolean))],
      });
      onClose();
    } catch (e) {
      setError((e as Error).message || "That didn't save. Try again.");
      setBusy(false);
    }
  }

  const submitOnEnter = (e: React.KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); void add(); } };

  return (
    <dialog
      ref={ref} aria-label="New card"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      // A stray click outside shouldn't throw away something already typed.
      onClick={(e) => { if (e.target === ref.current && !dirty) onClose(); }}
    >
      <div className="dialog-body">
        <h2 className="h">NEW_CARD</h2>
        <input
          className="field title-input" value={title} maxLength={200} aria-label="Title" placeholder="What needs doing?" autoFocus
          onChange={(e) => setTitle(e.target.value)} onKeyDown={submitOnEnter}
        />
        <label>
          Notes
          <textarea
            className="field" value={notes} maxLength={4000} placeholder="Details, links, anything… Markdown works."
            onChange={(e) => setNotes(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void add(); } }}
          />
        </label>
        <div className="dialog-row">
          <label>
            Lane
            <select className="field" value={lane} onChange={(e) => setLane(e.target.value)}>
              {lanes.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          <label>
            Due
            <input className="field" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
        </div>
        <label>
          Tags
          <input
            className="field mono" value={tags} placeholder="agent client" spellCheck={false} autoCapitalize="off"
            onChange={(e) => setTags(e.target.value)} onKeyDown={submitOnEnter}
          />
        </label>
        {error && <div className="dialog-error" role="alert">{error}</div>}
        <div className="dialog-meta">Files can be attached once the card is added.</div>
      </div>
      <div className="dialog-foot">
        <button className="btn" onClick={onClose}><IconClose />Cancel</button>
        <span className="spacer" />
        <button className="btn primary" disabled={!title.trim() || busy} onClick={() => void add()}><IconPlus />Add card</button>
      </div>
    </dialog>
  );
}
