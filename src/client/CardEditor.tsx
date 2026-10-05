import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cleanTag, doneLaneId, type Card, type Lane } from "../shared";
import { isOwnerTag, ownerTagLike, ownerTagTyped } from "../member-rules";
import { AskBlock, AskOwnerContext } from "./Ask";
import { AGENT_HOLDS, agentHeld, ASK_HOLDS, ByLine, ChangedWhileOpen, changer, CLAIM_HOLD_MS, MemberWords, OWNER_TAG_NOTE, ownerTagTouched, WhoContext, type Mode } from "./member";
import { DraftsContext, hasDraft, Unsaved, type Draft } from "./Unsaved";
import { NoAgentLine } from "./AgentNudge";
import { Attachments, NoFiles } from "./Attachments";
import { DiscardBar, useDiscardGuard } from "./Discard";
import { MODAL, useModal } from "./modal";
import { Markdown, toggleTask } from "./Markdown";
import { NotesFullButton } from "./NotesFull";
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
  /** Move to the done lane, or back out of it. Missing when the board has no done lane. */
  onToggleDone?(): void;
  isDone: boolean;
  onClose(): void;
  /** Who's looking (// TEAM_BOARDS). Left out, the owner. A viewer gets the card to read and nothing to press. */
  mode?: Mode;
  /** The owner's id, on a board someone shared with you: files go to and come from that board. */
  board?: string;
  /** On a shared board: it's view only because its owner's Pro plan lapsed, not because of your role. */
  lapsed?: boolean;
  /**
   * The owner's "These words are mine now": take the member's mark off this card, as it's
   * saved and on screen right now. Resolves to null when it's done, or to why it was refused
   * (the card changed first). Only the owner's own board passes it.
   */
  onClaim?(): Promise<string | null>;
};

/**
 * The card, for whoever opened it. A viewer gets a read-only view; everyone else gets the
 * editor. The role comes from the server and can change while the card is open (a writer made
 * a viewer, or the owner's plan lapsing), and the dialog follows it on the spot.
 */
export function CardEditor(props: Props) {
  // What's been typed and not saved, kept here, above both views. When the editor turns into
  // the read-only view under someone (made a viewer, the owner's plan lapsing, the owner
  // tagging the card for an agent), their text is still on screen to copy, and it's back in
  // the fields if the editor returns.
  const draft = useRef<Draft | null>(null);
  // The board keeps the same text (DraftsContext), so it isn't lost if the whole board closes
  // under this dialog: a member who's removed finds it on their own board. CardEdit reports it;
  // it's dropped here, when the card is closed, so it outlives the swap to the read-only view.
  const drafts = useContext(DraftsContext);
  const key = `card:${props.card.id}`;
  useEffect(() => () => drafts?.report(key, null), [drafts, key]);
  // An agent's work order is read only to a writer too (OWNER_TAGS in member-rules.ts).
  return props.mode === "viewer" || agentHeld(props.mode, props.card)
    ? <CardView {...props} unsaved={draft.current} />
    : <CardEdit {...props} draft={draft} />;
}

/** A card to read: the notes rendered with their checkboxes fixed, the files to open or download, and one button, Close. */
function CardView({ card, lanes, vault, board, onClose, mode, lapsed, unsaved }: Props & { unsaved?: Draft | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  const owner = useContext(AskOwnerContext);
  // A writer lands here only on an agent's work order; a viewer lands here on every card.
  const held = agentHeld(mode, card);
  useModal(ref, {
    focus: (dialog) => dialog.focus(),
    fallback: () => document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(card.id)}"]`),
  });
  const lane = lanes.find((l) => l.id === card.laneId)?.name ?? "";
  return (
    <dialog
      ref={ref} className="card-dialog card-view" {...MODAL} aria-label={`Card: ${card.title}`} tabIndex={-1}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      <div className="dialog-body">
        <div className="dialog-top">
          <h2 className="h">CARD</h2>
          <span className="role-chip" data-role="viewer">{held ? "read only" : "view only"}</span>
          <button type="button" className="btn ghost icon dialog-x" aria-label="Close" title="Close (Esc)" onClick={onClose}><IconClose /></button>
        </div>
        <h3 className="card-view-title">{card.title}</h3>
        {held && <p className="held-note">{AGENT_HOLDS(owner ?? "the board's owner")}</p>}
        {hasDraft(unsaved) && (
          <Unsaved draft={unsaved} why={held
            ? `${owner ?? "The board's owner"} made this card a work order for their agents while you were editing it.`
            : lapsed ? `${owner ?? "The board's owner"}'s Pro plan lapsed while you were editing this card, so the board is view only.`
            : "Your role changed to viewer while you were editing this card."} />
        )}
        <AskBlock card={card} />
        <div className="notes-read">
          <div className="notes-head"><span id="notes-label">Notes</span></div>
          {card.notes.trim()
            ? <div className="field md-view static" role="group" aria-labelledby="notes-label"><Markdown text={card.notes} fixed={held ? `Read only: this card is ${owner ?? "the owner"}'s agents' to work.` : owner ? `View only: checkboxes on ${owner}'s board are for writers to tick.` : "View only: you can't tick these."} /></div>
            : <p className="attachments-empty">No notes.</p>}
        </div>
        <dl className="card-facts">
          <div><dt>Lane</dt><dd>{lane}</dd></div>
          <div><dt>Due</dt><dd>{card.due ? new Date(`${card.due}T12:00:00`).toLocaleDateString(undefined, { dateStyle: "medium" }) : "none"}</dd></div>
          <div><dt>Tags</dt><dd>{card.tags?.length ? card.tags.map((t) => <span key={t} className="chip tag">#{t}</span>) : "none"}</dd></div>
        </dl>
        <Attachments cardId={card.id} vault={vault} attachments={card.attachments ?? []} onRemove={() => {}} dropTarget={ref} board={board} readOnly />
        <div className="dialog-meta">
          created {new Date(card.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
          <ByLine card={card} />
        </div>
      </div>
      <div className="dialog-foot">
        <span className="view-note">{held ? `Read only: ${owner ?? "the owner"}'s agent card.` : owner ? `View only on ${owner}'s board${lapsed ? " until their Pro plan is back" : ""}.` : "View only."}</span>
        <span className="spacer" />
        <button className="btn primary" onClick={onClose}>Close</button>
      </div>
    </dialog>
  );
}

/**
 * Edit a card. Save (or Enter in the title or tags) keeps the changes. The X and Esc throw them
 * away, so opening a card to read it can't change it by accident; if something was edited they
 * ask "Discard changes?" first. Files are the exception: they upload and come off as you go,
 * and Undo covers a removal, so they don't count as edits.
 */
function CardEdit({ card, lanes, knownTags, vault, filesNote, onSave, onMove, onMoveNow, onDelete, onRemoveAttachment, onToggleDone, isDone, onClose, mode, board, draft, onClaim }: Props & { draft: React.MutableRefObject<Draft | null> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const drafts = useContext(DraftsContext);
  // A writer can't finish or delete a card while its question is open: that would end the
  // agent's wait, which is the owner's call. Those controls aren't offered, and a line says why.
  const owner = useContext(AskOwnerContext);
  const held = mode === "writer" && !!card.ask;
  const doneLane = doneLaneId(lanes);
  const heldLane = (id: string) => held && id === doneLane && card.laneId !== doneLane;
  // Whatever was typed before the editor last went read only comes back with it.
  const [title, setTitle] = useState(draft.current?.title ?? card.title);
  const [notes, setNotes] = useState(draft.current?.notes ?? card.notes);
  const [due, setDue] = useState(card.due ?? "");
  // A trailing space says the last tag is finished, so the field suggests more tags instead of
  // treating that tag as half typed.
  // The owner's tags on the card (#needs-ceo on a card with a question, #ship-ok) aren't a
  // writer's to take off, so for a writer they aren't in the field at all: they show locked
  // under it, and Save sends them back as they were.
  const locked = mode === "writer" ? (card.tags ?? []).filter(isOwnerTag) : [];
  const own = (card.tags ?? []).filter((t) => !locked.includes(t));
  const ownText = own.map((t) => `${t} `).join("");
  const [tags, setTags] = useState(draft.current?.tags ?? ownText);
  // Kept for the read-only view (CardEditor above): the fields that differ from the card, as typed.
  useEffect(() => {
    draft.current = {
      ...(title.trim() && title.trim() !== card.title ? { title } : {}),
      ...(notes !== card.notes ? { notes } : {}),
      ...(tags.trim() !== ownText.trim() ? { tags: tags.trim() } : {}),
    };
    drafts?.report(`card:${card.id}`, hasDraft(draft.current) ? { ...draft.current, where: `The card "${card.title}"` } : null);
  });
  // Notes read as markdown and edit as plain text. A card with no notes opens ready to type.
  const [editing, setEditing] = useState(!card.notes.trim() || draft.current?.notes !== undefined);
  const [lane, setLane] = useState(card.laneId);
  // Notes take the whole dialog while this is on (the expander next to the Notes label).
  const [full, setFull] = useState(false);
  const latest = useRef({ title, notes, due, tags, lane });
  latest.current = { title, notes, due, tags, lane };

  // The owner's editor follows the card while it's open. The fields above were filled in when
  // the dialog opened; if a member (or anyone else) rewrites the card after that, a field the
  // owner hasn't touched takes the new words, a field they have typed in keeps their typing,
  // and either way a notice says who changed it and shows what the card says now. Without it
  // the owner would be looking at the old words while "These words are mine now" spoke for
  // the new ones.
  const ownerHere = !mode || mode === "owner";
  const shown = useRef({ title: card.title, notes: card.notes, tags: ownText });
  const me = useContext(WhoContext)?.me;
  const [changed, setChanged] = useState<{ who: string; kept: boolean } | null>(null);
  const [claimHold, setClaimHold] = useState(false);
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimError, setClaimError] = useState("");
  useEffect(() => {
    const was = shown.current;
    if (!ownerHere || (was.title === card.title && was.notes === card.notes && was.tags === ownText)) return;
    shown.current = { title: card.title, notes: card.notes, tags: ownText };
    const mine = latest.current;
    let kept = false;
    if (card.title !== was.title) { if (mine.title === was.title) setTitle(card.title); else kept = true; }
    if (card.notes !== was.notes) { if (mine.notes === was.notes) setNotes(card.notes); else kept = true; }
    if (ownText !== was.tags) { if (mine.tags.trim() === was.tags.trim()) setTags(ownText); else kept = true; }
    setChanged((c) => ({ who: changer(card.by, me), kept: kept || !!c?.kept }));
    // A click that was already on its way mustn't land on words nobody has read yet.
    setClaimHold(true);
    const t = setTimeout(() => setClaimHold(false), CLAIM_HOLD_MS);
    return () => clearTimeout(t);
  }, [ownerHere, card.title, card.notes, ownText]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Whether the fields hold words that aren't the card's saved ones: then the claim shows the saved ones next to its button. */
  const typedOver = title.trim() !== card.title || notes !== card.notes || tags.trim() !== ownText.trim();
  async function claim() {
    if (!onClaim || claimBusy || claimHold) return;
    setClaimBusy(true);
    setClaimError("");
    const no = await onClaim().catch(() => "That didn't go through. Try again.");
    setClaimBusy(false);
    if (no) setClaimError(no);
  }

  // showModal() puts focus on the first control, which is the X ("Close without saving"). The
  // title is the better place to land: it says which card this is, and it's what gets edited
  // most. On a touch screen a focused text field pops the keyboard over a card someone may
  // only want to read, so focus goes to the dialog itself there.
  // Closing gives focus back to the card it was opened from: the same element when it's still on
  // the board, or the card where it was redrawn after a move.
  useModal(ref, {
    focus: (dialog) => {
      const field = dialog.querySelector<HTMLTextAreaElement>(".title-input");
      if (!field || matchMedia("(hover: none) and (pointer: coarse)").matches) { dialog.focus(); return; }
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    },
    fallback: () => document.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(card.id)}"]`),
  });

  // CSS `field-sizing: content` grows the notes to fit. Where it's missing (Firefox), size it by hand;
  // min-height and max-height in the stylesheet still clamp the result.
  const notesRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = notesRef.current;
    if (!el || CSS.supports("field-sizing", "content")) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [notes, editing, full]);

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
    if (nextTags.join(" ") !== own.join(" ")) patch.tags = [...locked, ...nextTags.filter((t) => !locked.includes(t))];
    return { patch, lane: l !== card.laneId ? l : null };
  }

  // A writer can't add or remove the tags that direct the owner's agents. Said here, with the
  // dialog still open and the field still editable, because the server would refuse the save.
  const [error, setError] = useState("");
  function refusedTag(patch: { title?: string; tags?: string[] }): boolean {
    if (mode !== "writer") return false;
    const who = owner ?? "the board's owner";
    const inTags = patch.tags ? ownerTagTouched(card.tags ?? [], patch.tags) : null;
    // The same reading the server makes, with what was typed, so "#ag3nt reads as #agent." is said here too.
    const titled = patch.title !== undefined ? ownerTagTyped(patch.title) : null;
    const inTitle = titled?.tag ?? null;
    // What they typed, when it only reads as the owner's tag (`ship_ok`, a look-alike letter).
    const typed = inTags ? patch.tags!.find((t) => !(card.tags ?? []).includes(t) && ownerTagLike(t) === inTags) : undefined;
    if (inTags) setError(`${OWNER_TAG_NOTE(inTags, who, typed)} ${typed ? `Take ${typed} out of Tags` : `Put ${inTags} back in Tags`} to save.`);
    else if (inTitle) setError(`${OWNER_TAG_NOTE(inTitle, who, titled?.typed)} Take the # tag out of the title to save.`);
    return !!(inTags || inTitle);
  }

  function save() {
    const { patch, lane: to } = pending();
    if (refusedTag(patch)) return false;
    if (Object.keys(patch).length) onSave(patch);
    if (to) onMove(to);
    onClose();
    return true;
  }

  // The Move to buttons, shown on touch screens, where dragging a card to another lane is the
  // hard way. Unlike the Lane select, which waits for Save, a tap here is the whole action: it
  // keeps the other edits, moves the card, and closes, the way Mark done does.
  function moveNow(to: string) {
    const { patch } = pending();
    if (refusedTag(patch)) return;
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
      ref={ref} className={full ? "card-dialog notes-full" : "card-dialog"} {...MODAL} aria-label={`Edit card: ${title.trim() || "no title"}`} tabIndex={-1}
      {...guard.dialogProps}
      // A stray click outside closes an untouched card, but shouldn't throw away something already typed.
      onClick={(e) => { if (e.target === ref.current && !edited()) onClose(); }}
    >
      <div className="dialog-body">
        <div className="dialog-top">
          <h2 className="h">CARD</h2>
          <button type="button" className="btn ghost icon dialog-x" aria-label="Close without saving" title="Close without saving (Esc)" onClick={guard.requestClose}><IconClose /></button>
        </div>
        <TitleInput value={title} onChange={(v) => { setTitle(v); if (error) setError(""); }} onEnter={save} />
        <CardSession cardId={card.id} />
        {/* Save and close first, like answering a question: the link leaves the board. */}
        <NoAgentLine card={card} before={save} />
        {lanes.length > 1 && (
          <div className="move-row" role="group" aria-label="Move to lane">
            <span className="move-label">Move to</span>
            {lanes.map((l) => (
              <button
                key={l.id} type="button" className="btn move-to" disabled={l.id === card.laneId || heldLane(l.id)}
                aria-current={l.id === card.laneId ? "true" : undefined}
                title={l.id === card.laneId ? `In ${l.name} now` : heldLane(l.id) ? "Not until the owner answers the question" : `Move to ${l.name}`}
                onClick={() => moveNow(l.id)}
              >{l.id === card.laneId && <span className="move-mark" aria-hidden="true">$</span>}{l.name}</button>
            ))}
          </div>
        )}
        {/* Save and close first: answering rewrites the notes and tags this dialog is holding. */}
        <AskBlock card={card} before={save} />
        {held && <p className="held-note">{ASK_HOLDS(owner ?? "the board's owner")}</p>}
        {/* The owner's own board: what a member put on this card, what that means, and the one way it comes off. */}
        {ownerHere && changed && <ChangedWhileOpen card={card} who={changed.who} kept={changed.kept && typedOver} onDismiss={() => setChanged(null)} />}
        {ownerHere && <MemberWords card={card} onClaim={onClaim ? () => void claim() : undefined} hold={claimHold} busy={claimBusy} error={claimError} saved={(typedOver || !!claimError) && !changed} />}
        <div className="notes-read">
          <div className="notes-head">
            <span id="notes-label">Notes</span>
            {!editing && <button type="button" className="notes-edit" onClick={edit}>Edit</button>}
            <NotesFullButton full={full} onToggle={() => setFull((f) => !f)} />
          </div>
          {editing ? (
            <textarea
              ref={notesRef} className="field" value={notes} placeholder="Details, links, anything…" aria-labelledby="notes-label"
              onChange={(e) => setNotes(e.target.value)}
              onBlur={(e) => {
                // A click on Close, Mark done, or Delete is about to end the dialog; swapping the
                // view first would move the button out from under the pointer. The expander only
                // resizes the box, so typing carries on in it.
                if (e.relatedTarget instanceof Element && e.relatedTarget.closest(".dialog-foot, .notes-full-btn")) return;
                if (latest.current.notes.trim()) setEditing(false);
              }}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && latest.current.notes.trim()) setEditing(false); }}
            />
          ) : (
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
          )}
        </div>
        <div className="dialog-row">
          <label>
            Lane
            <select className="field" value={lane} onChange={(e) => setLane(e.target.value)}>
              {lanes.map((l) => <option key={l.id} value={l.id} disabled={heldLane(l.id)}>{l.name}</option>)}
            </select>
          </label>
          <label>
            Due
            <input className="field" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
        </div>
        <TagField value={tags} onChange={(v) => { setTags(v); if (error) setError(""); }} known={knownTags} onEnter={save} placeholder={mode === "writer" ? "client urgent" : undefined} />
        {locked.length > 0 && (
          <p className="held-note tag-lock">
            {locked.map((t) => <span key={t} className="chip tag">#{t}</span>)}
            <span>{locked.length === 1 ? "is" : "are"} {owner ?? "the board's owner"}'s to put on or take off, so {locked.length === 1 ? "it stays" : "they stay"} on this card whatever you save here.{card.ask && locked.includes("needs-ceo") ? " #needs-ceo comes off when they answer the question." : ""}</span>
          </p>
        )}
        {error && <div className="dialog-error" role="alert">{error}</div>}
        {filesNote ? <NoFiles note={filesNote} /> : (
          <Attachments cardId={card.id} vault={vault} attachments={card.attachments ?? []} onRemove={onRemoveAttachment} dropTarget={ref} board={board} />
        )}
        <div className="dialog-meta">
          created {new Date(card.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
          <ByLine card={card} marks={!!mode && mode !== "owner"} />
        </div>
      </div>
      {guard.asking ? <DiscardBar onKeep={guard.keep} onDiscard={onClose} /> : (
      <div className="dialog-foot">
        {!held && <button className="btn danger" onClick={() => { onDelete(); onClose(); }}><IconTrash />Delete</button>}
        <span className="spacer" />
        {onToggleDone && (!held || isDone) && (
          <button className="btn" onClick={() => { if (save()) onToggleDone(); }}>
            {isDone ? <><IconUndo />Reopen</> : <><IconCheck />Mark done</>}
          </button>
        )}
        <button className="btn primary" onClick={save}>Save</button>
      </div>
      )}
    </dialog>
  );
}
