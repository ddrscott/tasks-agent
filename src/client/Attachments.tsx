import { useCallback, useEffect, useRef, useState } from "react";
import type { Attachment } from "../shared";
import { api } from "./base";
import { IconClip, IconClose } from "./icons";
import { openSealedFile, uploadSealed } from "./migrate";
import type { Vault } from "./vault";

// The attachments section of the card editor. Files upload straight to the Worker,
// which stores them in R2 and adds them to the card; the new list then arrives with
// the synced board like any other change.
//
// On an encrypted board the file is encrypted here first, and opening one downloads the
// ciphertext and decrypts it in the tab. Only types that can't run scripts open inline.

const fileUrl = (a: Attachment, download = false) => api(`/api/attachments/${a.id}${download ? "?download=1" : ""}`);
const isImage = (a: Attachment) => /^image\/(png|jpeg|gif|webp|avif)$/.test(a.type);
// Matches the Worker's INLINE list: a decrypted file of any other type is only ever saved, never opened here.
const INLINE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "application/pdf", "text/plain"]);
const THUMB_MAX = 8 * 1024 * 1024;

function save(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

async function upload(cardId: string, file: File): Promise<void> {
  const r = await fetch(api(`/api/attachments?card=${encodeURIComponent(cardId)}`), {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream", "X-Filename": encodeURIComponent(file.name) },
    body: file,
  });
  if (!r.ok) {
    const data = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Couldn't upload ${file.name}.`);
  }
}

type Props = {
  cardId: string;
  vault: Vault | null;
  attachments: Attachment[];
  onRemove(id: string): void;
  /** The element that accepts dropped and pasted files, usually the whole dialog. */
  dropTarget: React.RefObject<HTMLElement | null>;
};

export function Attachments({ cardId, vault, attachments, onRemove, dropTarget }: Props) {
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // One at a time, so each upload's quota check sees the ones before it.
  const add = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setError(null);
    setPending((p) => [...p, ...files.map((f) => f.name)]);
    for (const f of files) {
      try {
        if (vault) await uploadSealed(vault, { name: f.name, type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) }, cardId);
        else await upload(cardId, f);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setPending((p) => { const i = p.indexOf(f.name); return i < 0 ? p : [...p.slice(0, i), ...p.slice(i + 1)]; });
      }
    }
  }, [cardId, vault]);

  useEffect(() => {
    const el = dropTarget.current;
    if (!el) return;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    const onOver = (e: DragEvent) => { if (hasFiles(e)) { e.preventDefault(); setOver(true); } };
    const onLeave = (e: DragEvent) => { if (!el.contains(e.relatedTarget as Node | null)) setOver(false); };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setOver(false);
      void add([...e.dataTransfer!.files]);
    };
    // Pasting a screenshot attaches it; pasting text into a field works as usual.
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) { e.preventDefault(); void add(files); }
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
  }, [dropTarget, add]);

  return (
    <div className={`attachments${over ? " over" : ""}`}>
      <div className="attachments-head">
        <span>Attachments</span>
        <button type="button" className="btn ghost" onClick={() => input.current?.click()}><IconClip />Attach files</button>
        <input
          ref={input} type="file" multiple hidden
          onChange={(e) => { void add([...(e.target.files ?? [])]); e.target.value = ""; }}
        />
      </div>
      {attachments.length === 0 && pending.length === 0 && (
        <p className="attachments-empty">{over ? "Drop to attach" : "Drop files here, paste a screenshot, or use Attach files."}</p>
      )}
      {(attachments.length > 0 || pending.length > 0) && (
        <ul>
          {vault && attachments.map((a) => <SealedFile key={a.id} a={a} vault={vault} onRemove={onRemove} onError={setError} />)}
          {!vault && attachments.map((a) => (
            <li key={a.id}>
              <a className="att-thumb" href={fileUrl(a)} target="_blank" rel="noreferrer" title={`Open ${a.name}`}>
                {isImage(a) ? <img src={fileUrl(a)} alt="" loading="lazy" /> : <span>{(a.name.split(".").pop() ?? "").slice(0, 4) || "file"}</span>}
              </a>
              <a className="att-name" href={fileUrl(a)} target="_blank" rel="noreferrer">{a.name}</a>
              <span className="att-size">{formatBytes(a.size)}</span>
              <a className="btn ghost" href={fileUrl(a, true)} download={a.name} title="Download">↓</a>
              <button type="button" className="btn ghost icon" title={`Remove ${a.name}`} onClick={() => onRemove(a.id)}><IconClose /></button>
            </li>
          ))}
          {pending.map((name, i) => (
            <li key={`pending-${i}`} className="pending">
              <span className="att-thumb"><span>$</span></span>
              <span className="att-name">{name}</span>
              <span className="att-size">uploading…</span>
            </li>
          ))}
        </ul>
      )}
      {error && <div className="login-error" role="alert">{error}</div>}
    </div>
  );
}

/** One file on an encrypted board: decrypted in the tab when it's opened, saved, or shown as a thumbnail. */
function SealedFile({ a, vault, onRemove, onError }: { a: Attachment; vault: Vault; onRemove(id: string): void; onError(e: string): void }) {
  const [url, setUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  const inline = INLINE.has(a.type);
  const load = useCallback(async () => {
    if (urlRef.current) return urlRef.current;
    const bytes = await openSealedFile(vault.key, a.id);
    urlRef.current = URL.createObjectURL(new Blob([bytes as BlobPart], { type: inline ? a.type : "application/octet-stream" }));
    setUrl(urlRef.current);
    return urlRef.current;
  }, [vault, a.id, a.type, inline]);
  useEffect(() => {
    if (isImage(a) && a.size < THUMB_MAX) load().catch(() => {});
    return () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function open(download: boolean) {
    // Open the tab now, while the click still counts, and point it at the file once it's decrypted.
    const w = inline && !download ? window.open("", "_blank") : null;
    try {
      const u = await load();
      if (w) w.location.href = u;
      else save(u, a.name);
    } catch {
      w?.close();
      onError(`Couldn't decrypt ${a.name}.`);
    }
  }

  return (
    <li>
      <button type="button" className="att-thumb" onClick={() => void open(false)} title={`Open ${a.name}`}>
        {isImage(a) && url ? <img src={url} alt="" /> : <span>{(a.name.split(".").pop() ?? "").slice(0, 4) || "file"}</span>}
      </button>
      <button type="button" className="att-name linkish" onClick={() => void open(false)}>{a.name}</button>
      <span className="att-size">{formatBytes(a.size)}</span>
      <button type="button" className="btn ghost" onClick={() => void open(true)} title="Download">↓</button>
      <button type="button" className="btn ghost icon" title={`Remove ${a.name}`} onClick={() => onRemove(a.id)}><IconClose /></button>
    </li>
  );
}
