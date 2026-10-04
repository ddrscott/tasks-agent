// The full dialog for a new card, opened by the + in a lane's header: title, notes, lane, due
// date, tags, and files in one go. Nothing is added until Add card, so backing out leaves no empty
// card. Files wait in the dialog and upload once the card exists to hang them on.
// The "Add a card" row at the bottom of a lane is still the quick way to type one title or paste a list.

import { isOwnerTag, plainError } from "../member-rules";
import { useContext, useEffect, useRef, useState } from "react";
import { AskOwnerContext } from "./Ask";
import { OWNER_TAG_NOTE } from "./member";
import { cleanTag, splitTitleTags, type Lane } from "../shared";
import { formatBytes, NoFiles, uploadFile } from "./Attachments";
import { DiscardBar, useDiscardGuard } from "./Discard";
import { MODAL, useModal } from "./modal";
import { NotesFullButton } from "./NotesFull";
import { IconClip, IconClose, IconPlus } from "./icons";
import { TagField } from "./TagField";
import { TitleInput } from "./TitleInput";
import type { Vault } from "./vault";

export type NewCardInput = { laneId: string; title: string; notes: string; due: string | null; tags: string[] };

type Props = {
  lanes: Lane[];
  /** The lane whose + was clicked. */
  laneId: string;
  /** Tags in use on the board, most used first. */
  knownTags: string[];
  /** Set on an encrypted board: files are encrypted before upload. */
  vault: Vault | null;
  /** Set where files can't be stored (the demo board): shown in place of the attach controls. */
  filesNote?: string;
  /** The owner's id, on a board someone shared with you: files upload to that board. */
  board?: string;
  /** Adds the card and resolves to its id. */
  onAdd(input: NewCardInput): Promise<string>;
  onClose(): void;
};

export function NewCard({ lanes, laneId, knownTags, vault, filesNote, board, onAdd, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  // Notes take the whole dialog while this is on (the expander next to the Notes label).
  const [full, setFull] = useState(false);
  const [lane, setLane] = useState(laneId);
  const [due, setDue] = useState("");
  const [tags, setTags] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [over, setOver] = useState(false);
  // Set once the card exists. From then on Add card only retries the files that didn't upload.
  const [addedId, setAddedId] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  // Set on a board someone shared with you: the owner's email. The tags that direct their agents are theirs.
  const owner = useContext(AskOwnerContext);

  // showModal() would put focus on the X. The title is where typing starts.
  useModal(ref, { focus: (dialog) => dialog.querySelector<HTMLTextAreaElement>(".title-input")?.focus() });

  // Dropping files on the dialog or pasting a screenshot queues them, the same as in the card editor.
  useEffect(() => {
    const el = ref.current;
    if (!el || filesNote) return;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    const onOver = (e: DragEvent) => { if (hasFiles(e)) { e.preventDefault(); setOver(true); } };
    const onLeave = (e: DragEvent) => { if (!el.contains(e.relatedTarget as Node | null)) setOver(false); };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setOver(false);
      setFiles((f) => [...f, ...e.dataTransfer!.files]);
    };
    const onPaste = (e: ClipboardEvent) => {
      const pasted = [...(e.clipboardData?.files ?? [])];
      if (pasted.length) { e.preventDefault(); setFiles((f) => [...f, ...pasted]); }
    };
    el.addEventListener("dragover", onOver);
    el.addEventListener("dragleave", onLeave);
    el.addEventListener("drop", onDrop);
    el.addEventListener("paste", onPaste);
    return () => {
      el.removeEventListener("dragover", onOver);
      el.removeEventListener("dragleave", onLeave);
      el.removeEventListener("drop", onDrop);
      el.removeEventListener("paste", onPaste);
    };
  }, [filesNote]);

  const dirty = !!(title.trim() || notes.trim() || due || tags.trim() || files.length);
  // The X and Esc ask before throwing away what was typed or queued. Once the card is added
  // there's nothing left to lose but a retry, so they just close.
  const guard = useDiscardGuard(() => dirty && !addedId, onClose);

  // "Write a haiku #agent" in the title: the #agent moves down into the Tags field, where it can be
  // seen and taken back out. It happens on leaving the title, and again on Add card in case Enter
  // was hit straight from the title.
  function moveTitleTags() {
    const have = [...new Set(tags.split(/[\s,]+/).map(cleanTag).filter(Boolean))];
    const split = splitTitleTags(title, have);
    if (split.title !== title) {
      setTitle(split.title);
      const fresh = split.tags.slice(have.length);
      if (fresh.length) setTags(`${tags.trim() ? `${tags.trimEnd()} ` : ""}${fresh.join(" ")} `);
    }
    return split;
  }

  async function add() {
    if ((!title.trim() && !addedId) || busy) return;
    setBusy(true);
    setError("");
    let id = addedId;
    try {
      if (!id) {
        const split = moveTitleTags();
        // A member can't tag a card for the owner's agents. Said before anything is sent: the
        // tag is in the Tags field by now, where it can be seen and taken out.
        const ownerTag = owner ? split.tags.find(isOwnerTag) : undefined;
        if (ownerTag) {
          setError(`${OWNER_TAG_NOTE(ownerTag, owner!)} Take ${ownerTag} out of Tags to add this card.`);
          setBusy(false);
          return;
        }
        id = await onAdd({
          laneId: lanes.some((l) => l.id === lane) ? lane : laneId,
          title: split.title, notes, due: due || null,
          tags: split.tags,
        });
        setAddedId(id);
      }
    } catch (e) {
      setError(plainError((e as Error).message ?? "") || "That didn't save. Try again.");
      setBusy(false);
      return;
    }
    // One at a time, so each upload's quota check sees the ones before it.
    const failed: File[] = [];
    let why = "";
    for (const f of files) {
      try { await uploadFile(id, f, vault, board); } catch (e) { failed.push(f); why = (e as Error).message; }
    }
    if (!failed.length) return onClose();
    setFiles(failed);
    setError(`The card was added, but ${failed.length === 1 ? failed[0].name : `${failed.length} files`} didn't upload. ${why}`);
    setBusy(false);
  }

  const submitOnEnter = (e: React.KeyboardEvent) => { if (e.key === "Enter") { e.preventDefault(); void add(); } };

  return (
    <dialog
      ref={ref} className={full ? "card-dialog notes-full" : "card-dialog"} {...MODAL} aria-label="New card"
      {...guard.dialogProps}
      // A stray click outside shouldn't throw away something already typed.
      onClick={(e) => { if (e.target === ref.current && !dirty) onClose(); }}
    >
      <div className="dialog-body">
        <div className="dialog-top">
          <h2 className="h">NEW_CARD</h2>
          <button type="button" className="btn ghost icon dialog-x" aria-label={addedId ? "Close" : "Cancel"} title={addedId ? "Close (Esc)" : "Cancel (Esc)"} onClick={guard.requestClose}><IconClose /></button>
        </div>
        <TitleInput value={title} onChange={setTitle} onEnter={() => void add()} onBlur={() => { if (!busy && !addedId) moveTitleTags(); }} placeholder="What needs doing?" autoFocus />
        <div className="notes-read">
          <div className="notes-head">
            <label htmlFor="new-notes">Notes</label>
            <NotesFullButton full={full} onToggle={() => setFull((f) => !f)} />
          </div>
          <textarea
            id="new-notes" className="field" value={notes} maxLength={4000} placeholder="Details, links, anything… Markdown works."
            onChange={(e) => setNotes(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void add(); } }}
          />
        </div>
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
        <TagField value={tags} onChange={setTags} known={knownTags} onEnter={() => void add()} placeholder={owner ? "client urgent" : undefined} />
        {error && <div className="dialog-error" role="alert">{error}</div>}
        {filesNote ? <NoFiles note={filesNote} /> : (
        <div className={`attachments${over ? " over" : ""}`}>
          <div className="attachments-head">
            <span>Attachments</span>
            <button type="button" className="btn ghost" onClick={() => picker.current?.click()}><IconClip />Attach files</button>
            <input
              ref={picker} type="file" multiple hidden
              onChange={(e) => { const picked = [...(e.target.files ?? [])]; setFiles((f) => [...f, ...picked]); e.target.value = ""; }}
            />
          </div>
          {files.length > 0 && (
            <ul>
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`} className="queued">
                  <span className="att-thumb"><span>{busy ? "$" : (f.name.split(".").pop() ?? "").slice(0, 4) || "file"}</span></span>
                  <span className="att-name">{f.name}</span>
                  <span className="att-size">{busy ? "uploading…" : formatBytes(f.size)}</span>
                  <button type="button" className="btn ghost icon" title={`Remove ${f.name}`} aria-label={`Remove ${f.name}`} disabled={busy} onClick={() => setFiles((all) => all.filter((_, j) => j !== i))}><IconClose /></button>
                </li>
              ))}
            </ul>
          )}
        </div>
        )}
      </div>
      {guard.asking ? <DiscardBar onKeep={guard.keep} onDiscard={onClose} /> : (
      <div className="dialog-foot">
        <span className="spacer" />
        <button className="btn primary" disabled={(!title.trim() && !addedId) || busy} onClick={() => void add()}>
          {addedId ? <><IconClip />Try the upload again</> : <><IconPlus />{busy ? "Adding…" : "Add card"}</>}
        </button>
      </div>
      )}
    </dialog>
  );
}
