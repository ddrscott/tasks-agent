import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cleanTag, type Card, type Lane } from "../shared";
import { AskBlock } from "./Ask";
import { NoAgentLine } from "./AgentNudge";
import { Attachments, NoFiles } from "./Attachments";
import { DiscardBar, useDiscardGuard } from "./Discard";
import { Markdown, toggleTask } from "./Markdown";
import { CardSession } from "./Sessions";
import { TagField } from "./TagField";
import { TitleInput } from "./TitleInput";
import type { Vault } from "./vault";
import { IconCheck, IconClose, IconTrash, IconUndo } from "./icons";

type Props = {
  card: Card;
  lanes: Lane[];
  /** Tags in use on the board, most used first. */
  knownTags: string[];
  /** Set on an encrypted board: files are encrypted before upload and decrypted to view. */
  vault: Vault | null;
  /** Set where files can't be stored (the demo board): shown in place of the attach controls. */
  filesNote?: string;
  onSave(patch: { title?: string; notes?: string; due?: string | null; tags?: string[] }): void;
  onMove(laneId: string): void;
  /** A tap on a Move to button: move right away and say so, with Undo. */
  onMoveNow(laneId: string): void;
  onDelete(): void;
  onRemoveAttachment(id: string): void;
  /** Move to the done lane, or back out of it. Missing when the board has one lane. */
  onToggleDone?(): void;
  isDone: boolean;
  onClose(): void;
};

/**
 * Edit a card. Save (or Enter in the title or tags) keeps the changes. The X and Esc throw them
 * away, so opening a card to read it can't change it by accident; if something was edited they
 * ask "Discard changes?" first. Files are the exception: they upload and come off as you go,
 * and Undo covers a removal, so they don't count as edits.
 */
export function CardEditor({ card, lanes, knownTags, vault, filesNote, onSave, onMove, onMoveNow, onDelete, onRemoveAttachment, onToggleDone, isDone, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(card.title);
  const [notes, setNotes] = useState(card.notes);
  const [due, setDue] = useState(card.due ?? "");
  // A trailing space says the last tag is finished, so the field suggests more tags instead of
  // treating that tag as half typed.
  const [tags, setTags] = useState((card.tags ?? []).map((t) => `${t} `).join(""));
  // Notes read as markdown and edit as plain text. A card with no notes opens ready to type.
  const [editing, setEditing] = useState(!card.notes.trim());
  const [lane, setLane] = useState(card.laneId);
  const latest = useRef({ title, notes, due, tags, lane });
  latest.current = { title, notes, due, tags, lane };

  // showModal() puts focus on the first control, which is the X ("Close without saving"). The
  // title is the better place to land: it says which card this is, and it's what gets edited
  // most. On a touch screen a focused text field pops the keyboard over a card someone may
  // only want to read, so focus goes to the dialog itself there.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    const field = dialog.querySelector<HTMLTextAreaElement>(".title-input");
    if (!field || matchMedia("(hover: none) and (pointer: coarse)").matches) { dialog.focus(); return; }
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, []);

  // CSS `field-sizing: content` grows the notes to fit. Where it's missing (Firefox), size it by hand;
  // min-height and max-height in the stylesheet still clamp the result.
  const notesRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = notesRef.current;
    if (!el || CSS.supports("field-sizing", "content")) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [notes, editing]);

  // When the person asks to edit, focus the textarea with the cursor at the end of the note.
  // A card that opens with no notes shows the textarea too, but leaves focus on the title.
  const wantFocus = useRef(false);
  function edit() {
    wantFocus.current = true;
    setEditing(true);
  }
  useEffect(() => {
    const el = notesRef.current;
    if (!editing || !el || !wantFocus.current) return;
    wantFocus.current = false;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  /** What Save would change, compared with the card as it was opened. */
  function pending() {
    const { title: t, notes: n, due: d, tags: g, lane: l } = latest.current;
    const patch: { title?: string; notes?: string; due?: string | null; tags?: string[] } = {};
    if (t.trim() && t.trim() !== card.title) patch.title = t;
    if (n !== card.notes) patch.notes = n;
    if ((d || null) !== card.due) patch.due = d || null;
    const nextTags = [...new Set(g.split(/[\s,]+/).map(cleanTag).filter(Boolean))];
    if (nextTags.join(" ") !== (card.tags ?? []).join(" ")) patch.tags = nextTags;
    return { patch, lane: l !== card.laneId ? l : null };
  }

  function save() {
    const { patch, lane: to } = pending();
    if (Object.keys(patch).length) onSave(patch);
    if (to) onMove(to);
    onClose();
  }

  // The Move to buttons, shown on touch screens, where dragging a card to another lane is the
  // hard way. Unlike the Lane select, which waits for Save, a tap here is the whole action: it
  // keeps the other edits, moves the card, and closes, the way Mark done does.
  function moveNow(to: string) {
    const { patch } = pending();
    if (Object.keys(patch).length) onSave(patch);
    onMoveNow(to);
    onClose();
  }

  /** Whether Save would change anything. */
  const edited = () => { const { patch, lane: to } = pending(); return Object.keys(patch).length > 0 || !!to; };
  // The X and Esc: close and keep nothing, after asking if there's something to lose.
  const guard = useDiscardGuard(edited, onClose);

  return (
    <dialog
      ref={ref} className="card-dialog" aria-label="Edit card" tabIndex={-1}
      {...guard.dialogProps}
      // A stray click outside closes an untouched card, but shouldn't throw away something already typed.
      onClick={(e) => { if (e.target === ref.current && !edited()) onClose(); }}
    >
      <div className="dialog-body">
        <div className="dialog-top">
          <h2 className="h">CARD</h2>
          <button type="button" className="btn ghost icon dialog-x" aria-label="Close without saving" title="Close without saving (Esc)" onClick={guard.requestClose}><IconClose /></button>
        </div>
        <TitleInput value={title} onChange={setTitle} onEnter={save} />
        <CardSession cardId={card.id} />
        {/* Save and close first, like answering a question: the link leaves the board. */}
        <NoAgentLine card={card} before={save} />
        {lanes.length > 1 && (
          <div className="move-row" role="group" aria-label="Move to lane">
            <span className="move-label">Move to</span>
            {lanes.map((l) => (
              <button
                key={l.id} type="button" className="btn move-to" disabled={l.id === card.laneId}
                aria-current={l.id === card.laneId ? "true" : undefined}
                title={l.id === card.laneId ? `In ${l.name} now` : `Move to ${l.name}`}
                onClick={() => moveNow(l.id)}
              >{l.id === card.laneId && <span className="move-mark" aria-hidden="true">$</span>}{l.name}</button>
            ))}
          </div>
        )}
        {/* Save and close first: answering rewrites the notes and tags this dialog is holding. */}
        <AskBlock card={card} before={save} />
        {editing ? (
          <label>
            Notes
            <textarea
              ref={notesRef} className="field" value={notes} placeholder="Details, links, anything…"
              onChange={(e) => setNotes(e.target.value)}
              onBlur={(e) => {
                // A click on Close, Mark done, or Delete is about to end the dialog; swapping the
                // view first would move the button out from under the pointer.
                if (e.relatedTarget instanceof Element && e.relatedTarget.closest(".dialog-foot")) return;
                if (latest.current.notes.trim()) setEditing(false);
              }}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && latest.current.notes.trim()) setEditing(false); }}
            />
          </label>
        ) : (
          <div className="notes-read">
            <div className="notes-head">
              <span id="notes-label">Notes</span>
              <button type="button" className="notes-edit" onClick={edit}>Edit</button>
            </div>
            <div
              className="field md-view" tabIndex={0} role="group" aria-labelledby="notes-label"
              title="Click to edit"
              onClick={(e) => {
                // Links and checkboxes do their own thing, and dragging to select text isn't a click.
                if ((e.target as Element).closest("a, input")) return;
                if (getSelection()?.toString()) return;
                edit();
              }}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === "e") { e.preventDefault(); edit(); }
              }}
            >
              <Markdown text={notes} onToggle={(line) => setNotes((n) => toggleTask(n, line))} />
            </div>
          </div>
        )}
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
        <TagField value={tags} onChange={setTags} known={knownTags} onEnter={save} />
        {filesNote ? <NoFiles note={filesNote} /> : (
          <Attachments cardId={card.id} vault={vault} attachments={card.attachments ?? []} onRemove={onRemoveAttachment} dropTarget={ref} />
        )}
        <div className="dialog-meta">
          created {new Date(card.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
        </div>
      </div>
      {guard.asking ? <DiscardBar onKeep={guard.keep} onDiscard={onClose} /> : (
      <div className="dialog-foot">
        <button className="btn danger" onClick={() => { onDelete(); onClose(); }}><IconTrash />Delete</button>
        <span className="spacer" />
        {onToggleDone && (
          <button className="btn" onClick={() => { save(); onToggleDone(); }}>
            {isDone ? <><IconUndo />Reopen</> : <><IconCheck />Mark done</>}
          </button>
        )}
        <button className="btn primary" onClick={save}>Save</button>
      </div>
      )}
    </dialog>
  );
}
