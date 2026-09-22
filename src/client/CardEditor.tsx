import { useEffect, useRef, useState } from "react";
import type { Card, Lane } from "../shared";
import { IconClose, IconTrash } from "./icons";

type Props = {
  card: Card;
  lanes: Lane[];
  onSave(patch: { title?: string; notes?: string; due?: string | null }): void;
  onMove(laneId: string): void;
  onDelete(): void;
  onClose(): void;
};

/** Edit a card. Changes save when the dialog closes, however it closes. */
export function CardEditor({ card, lanes, onSave, onMove, onDelete, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(card.title);
  const [notes, setNotes] = useState(card.notes);
  const [due, setDue] = useState(card.due ?? "");
  const latest = useRef({ title, notes, due });
  latest.current = { title, notes, due };

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  function close() {
    const { title: t, notes: n, due: d } = latest.current;
    const patch: { title?: string; notes?: string; due?: string | null } = {};
    if (t.trim() && t.trim() !== card.title) patch.title = t;
    if (n !== card.notes) patch.notes = n;
    if ((d || null) !== card.due) patch.due = d || null;
    if (Object.keys(patch).length) onSave(patch);
    onClose();
  }

  return (
    <dialog
      ref={ref} aria-label="Edit card"
      onCancel={(e) => { e.preventDefault(); close(); }}
      onClick={(e) => { if (e.target === ref.current) close(); }}
    >
      <div className="dialog-body">
        <input
          className="field title-input" value={title} maxLength={200} aria-label="Title"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") close(); }}
        />
        <label>
          Notes
          <textarea className="field" value={notes} placeholder="Details, links, anything…" onChange={(e) => setNotes(e.target.value)} />
        </label>
        <div className="dialog-row">
          <label>
            Lane
            <select className="field" value={card.laneId} onChange={(e) => onMove(e.target.value)}>
              {lanes.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          <label>
            Due
            <input className="field" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
        </div>
        <div className="dialog-meta">
          created {new Date(card.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
        </div>
      </div>
      <div className="dialog-foot">
        <button className="btn danger" onClick={() => { onDelete(); onClose(); }}><IconTrash />Delete</button>
        <span className="spacer" />
        <button className="btn primary" onClick={close}><IconClose />Done</button>
      </div>
    </dialog>
  );
}
