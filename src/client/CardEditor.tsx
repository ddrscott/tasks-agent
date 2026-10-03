import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cleanTag, type Card, type Lane } from "../shared";
import { Attachments } from "./Attachments";
import type { Vault } from "./vault";
import { IconCheck, IconClose, IconTrash, IconUndo } from "./icons";

type Props = {
  card: Card;
  lanes: Lane[];
  /** Set on an encrypted board: files are encrypted before upload and decrypted to view. */
  vault: Vault | null;
  onSave(patch: { title?: string; notes?: string; due?: string | null; tags?: string[] }): void;
  onMove(laneId: string): void;
  onDelete(): void;
  onRemoveAttachment(id: string): void;
  /** Move to the done lane, or back out of it. Missing when the board has one lane. */
  onToggleDone?(): void;
  isDone: boolean;
  onClose(): void;
};

/** Edit a card. Changes save when the dialog closes, however it closes. */
export function CardEditor({ card, lanes, vault, onSave, onMove, onDelete, onRemoveAttachment, onToggleDone, isDone, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(card.title);
  const [notes, setNotes] = useState(card.notes);
  const [due, setDue] = useState(card.due ?? "");
  const [tags, setTags] = useState((card.tags ?? []).join(" "));
  const latest = useRef({ title, notes, due, tags });
  latest.current = { title, notes, due, tags };

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  // CSS `field-sizing: content` grows the notes to fit. Where it's missing (Firefox), size it by hand;
  // min-height and max-height in the stylesheet still clamp the result.
  const notesRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = notesRef.current;
    if (!el || CSS.supports("field-sizing", "content")) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [notes]);

  function close() {
    const { title: t, notes: n, due: d, tags: g } = latest.current;
    const patch: { title?: string; notes?: string; due?: string | null; tags?: string[] } = {};
    if (t.trim() && t.trim() !== card.title) patch.title = t;
    if (n !== card.notes) patch.notes = n;
    if ((d || null) !== card.due) patch.due = d || null;
    const nextTags = [...new Set(g.split(/[\s,]+/).map(cleanTag).filter(Boolean))];
    if (nextTags.join(" ") !== (card.tags ?? []).join(" ")) patch.tags = nextTags;
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
          <textarea ref={notesRef} className="field" value={notes} placeholder="Details, links, anything…" onChange={(e) => setNotes(e.target.value)} />
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
        <label>
          Tags
          <input
            className="field mono" value={tags} placeholder="agent client" spellCheck={false} autoCapitalize="off"
            onChange={(e) => setTags(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") close(); }}
          />
        </label>
        <Attachments cardId={card.id} vault={vault} attachments={card.attachments ?? []} onRemove={onRemoveAttachment} dropTarget={ref} />
        <div className="dialog-meta">
          created {new Date(card.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
        </div>
      </div>
      <div className="dialog-foot">
        <button className="btn danger" onClick={() => { onDelete(); onClose(); }}><IconTrash />Delete</button>
        <span className="spacer" />
        {onToggleDone && (
          <button className="btn" onClick={() => { close(); onToggleDone(); }}>
            {isDone ? <><IconUndo />Reopen</> : <><IconCheck />Mark done</>}
          </button>
        )}
        <button className="btn primary" onClick={close}><IconClose />Close</button>
      </div>
    </dialog>
  );
}
