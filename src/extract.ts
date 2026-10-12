// Text out of PDFs and Word files, so agents and search can read them (// PAGES and // SEARCH in
// the README). A board file's text is kept by the board's Docs object and a card attachment's by
// its TodoAgent, each in its own SQLite beside the row that names the file; the bytes stay in R2.
//
// - PDF: pdf.js, through `unpdf`, in the Worker. Workers AI `toMarkdown` was tried first and
//   returned empty pages for four of seven real PDFs (IRS and NIST documents with a text layer
//   that pdftotext and pdf.js both read), so it isn't used for PDFs.
// - Word (.docx): Workers AI `toMarkdown`, which keeps headings, lists, and tables. Without the
//   AI binding (`npm run dev:local`), or when it fails, the paragraphs are read straight out of
//   the file's XML instead: plain text, no table layout.
//
// A PDF with no text layer (a scan) has nothing to extract and is recorded as such: there's no
// OCR here. What comes out is data a person uploaded, never instructions; mcp.ts shows it
// between marker lines and says whose it is.

import { unzipSync, strFromU8 } from "fflate";
import { plainText, visibleText } from "./member-rules";
import type { Entry } from "./search-all";

export const PDF_TYPE = "application/pdf";
export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export type ExtractKind = "pdf" | "docx";

/** The most text kept from one file. Past it the text is cut and says so. */
export const EXTRACT_MAX_CHARS = 2_000_000;
/** The most extracted text one answer shows of one file; `offset` reads on from there. */
export const EXTRACT_SLICE = 32_000;
/** A value in a Durable Object's SQLite is at most 2 MB, so the text is stored in pieces. */
const CHUNK = 100_000;
/** About how much text one search row holds: a PDF page (a long one is split), or a stretch of a Word file. */
const SEGMENT = 6_000;
/** The most a .docx's main part may unzip to. */
const DOCX_XML_MAX = 64 * 1024 * 1024;

/** Whether text is extracted from a file of this type or name. Null for everything else, and for an encrypted file, whose name and type are ciphertext. */
export function extractKind(type: string, name: string): ExtractKind | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (type === PDF_TYPE || ext === "pdf") return "pdf";
  if (type === DOCX_TYPE || ext === "docx") return "docx";
  return null;
}

export type Extracted =
  /** `pageStarts[i]` is where page i + 1 begins in `text`. Null for a file with no pages (Word). */
  | { status: "text"; text: string; pageStarts: number[] | null; truncated: boolean }
  /** Nothing to read: a scan, or an empty document. */
  | { status: "empty"; pages: number | null }
  /** `retry` when asking again could go differently (a service was down), not when the file itself is the problem. */
  | { status: "failed"; error: string; retry: boolean };

/** Text as it's kept: line breaks normalized, control characters and characters nobody can see taken out (visibleText), blank runs closed up. */
const tidy = (s: string) => visibleText(plainText(s)).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

async function pdfText(bytes: Uint8Array): Promise<Extracted> {
  try {
    const { getDocumentProxy, extractText } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const pageStarts: number[] = [];
    let out = "";
    let truncated = false;
    for (const raw of text) {
      const page = tidy(raw);
      if (out.length + page.length + 2 > EXTRACT_MAX_CHARS) { truncated = true; break; }
      if (out) out += "\n\n";
      pageStarts.push(out.length);
      out += page;
    }
    if (!out.trim()) return { status: "empty", pages: totalPages };
    return { status: "text", text: out, pageStarts, truncated };
  } catch (e) {
    const name = (e as Error)?.name ?? "";
    const said = String((e as Error)?.message ?? e);
    if (/password/i.test(name) || /password/i.test(said)) return { status: "failed", error: "it's password-protected.", retry: false };
    if (/InvalidPDF|FormatError|MissingPDF|UnexpectedResponse/i.test(name) || /invalid pdf/i.test(said)) return { status: "failed", error: "it isn't a PDF this server can read. It may be damaged.", retry: false };
    console.warn("pdf extraction failed", name, said);
    return { status: "failed", error: "reading the PDF failed on the server.", retry: true };
  }
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unxml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10) || 0xfffd) : XML_ENTITIES[e] ?? m);

/** A .docx's paragraphs, read from word/document.xml. Null when the bytes aren't a .docx. */
function docxParagraphs(bytes: Uint8Array): string | null {
  let xml: string;
  try {
    const part = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" && f.originalSize <= DOCX_XML_MAX })["word/document.xml"];
    if (!part) return null;
    xml = strFromU8(part);
  } catch {
    return null;
  }
  const paras: string[] = [];
  for (const p of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []) {
    const runs = p.replace(/<w:tab\/>/g, "\t").replace(/<w:(br|cr)[^>]*\/>/g, "\n").match(/<w:t(?: [^>]*)?>[^<]*<\/w:t>|[\t\n]/g) ?? [];
    paras.push(unxml(runs.map((r) => (r.length === 1 ? r : r.replace(/<[^>]+>/g, ""))).join("")));
  }
  return paras.join("\n\n");
}

async function docxText(env: Env, bytes: Uint8Array, name: string): Promise<Extracted> {
  let text: string | null = null;
  try {
    const r = (await env.AI.toMarkdown({ name, blob: new Blob([bytes.slice().buffer as ArrayBuffer], { type: DOCX_TYPE }) })) as { data?: string; error?: string };
    // The service heads its answer with the file's name; the name is on the line that shows the text already.
    if (typeof r.data === "string" && !r.error) text = r.data.replace(/^# [^\n]*\n+/, "");
  } catch (e) {
    console.warn("toMarkdown unavailable, reading the .docx directly", (e as Error).message);
  }
  text ??= docxParagraphs(bytes);
  if (text === null) return { status: "failed", error: "it isn't a Word file this server can read. It may be damaged, or an older .doc saved with a .docx name.", retry: false };
  text = tidy(text);
  if (!text) return { status: "empty", pages: null };
  return { status: "text", text: text.slice(0, EXTRACT_MAX_CHARS), pageStarts: null, truncated: text.length > EXTRACT_MAX_CHARS };
}

/** The text of a PDF or Word file. Never throws: a file that can't be read says why. */
export function extractFile(env: Env, bytes: Uint8Array, kind: ExtractKind, name: string): Promise<Extracted> {
  return kind === "pdf" ? pdfText(bytes) : docxText(env, bytes, name);
}

/** The largest file text is extracted from: the upload cap (ATTACHMENT_MAX_MB), so nothing that could be uploaded is skipped for size. */
export const extractMaxBytes = (env: Env) => (Number(env.ATTACHMENT_MAX_MB) > 0 ? Number(env.ATTACHMENT_MAX_MB) : 25) * 1024 * 1024;

/** Read a file's bytes from R2 and extract its text. */
export async function extractFromR2(env: Env, r2Key: string, kind: ExtractKind, name: string): Promise<Extracted> {
  let obj: R2ObjectBody | null;
  try {
    obj = await env.ATTACHMENTS.get(r2Key);
  } catch (e) {
    console.warn("reading a file for extraction failed", (e as Error).message);
    return { status: "failed", error: "the file couldn't be read from storage just now.", retry: true };
  }
  if (!obj) return { status: "failed", error: "the file's bytes are missing from storage.", retry: true };
  if (obj.customMetadata?.sealed === "1") return { status: "failed", error: "it's encrypted, so the server can't read it.", retry: false };
  const max = extractMaxBytes(env);
  if (obj.size > max) return { status: "failed", error: `it's over the ${max / 1024 / 1024} MB that text is extracted from.`, retry: false };
  return extractFile(env, new Uint8Array(await obj.arrayBuffer()), kind, name);
}

/** What's known about one file's text. `pending` is never stored: it's a file nobody has tried yet. */
export type ExtractInfo = {
  status: "text" | "empty" | "failed";
  /** Length of the text, in characters. */
  chars: number;
  /** A PDF's page count. Null for Word files, which have none until they're laid out. */
  pages: number | null;
  /** The text was cut at EXTRACT_MAX_CHARS. */
  truncated: boolean;
  /** Why not, for `failed`. */
  error: string | null;
  retry: boolean;
  /** The etag of the bytes this came from: a file replaced since is extracted again. */
  etag: string;
  /** How many search rows the text is split into. */
  segs: number;
};
/** What a tool is told about a file: its extract, or that nobody has tried yet. */
export type ExtractState = ExtractInfo | { status: "pending" };

/** A stretch of a file's text, with where it sits. `text` has a `[page N]` line where each PDF page starts. */
export type Slice = { text: string; from: number; to: number; chars: number; pageFrom: number | null; pageTo: number | null; pages: number | null; truncated: boolean };

type InfoRow = { key: string; status: ExtractInfo["status"]; chars: number; pages: number | null; truncated: number; error: string | null; retry: number; etag: string; segs: number; page_starts: string | null };

/** The extracted text of one object's files (a board's files, or its card attachments), by key: a path, or an attachment id. */
export class Extracts {
  // The tables are named so no worksheet can be: a worksheet is a table of the person's own
  // naming in the same SQLite (sheets.ts, RESERVED). query_sheet can read them like it can read
  // `pages`: whoever may query a board's worksheets may read its files.
  constructor(private sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS _file_extracts (
      key TEXT PRIMARY KEY, status TEXT NOT NULL, chars INTEGER NOT NULL, pages INTEGER, truncated INTEGER NOT NULL, error TEXT,
      retry INTEGER NOT NULL, etag TEXT NOT NULL, segs INTEGER NOT NULL, page_starts TEXT, at TEXT NOT NULL)`);
    sql.exec("CREATE TABLE IF NOT EXISTS _file_extract_text (key TEXT NOT NULL, n INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY (key, n))");
  }

  private row(key: string): InfoRow | null {
    return this.sql.exec<InfoRow>("SELECT * FROM _file_extracts WHERE key = ?", key).toArray()[0] ?? null;
  }
  private info(r: InfoRow): ExtractInfo {
    return { status: r.status, chars: r.chars, pages: r.pages, truncated: !!r.truncated, error: r.error, retry: !!r.retry, etag: r.etag, segs: r.segs };
  }
  get(key: string): ExtractInfo | null {
    const r = this.row(key);
    return r ? this.info(r) : null;
  }
  /** Every file with an extract, by key. */
  all(): Map<string, ExtractInfo> {
    return new Map(this.sql.exec<InfoRow>("SELECT * FROM _file_extracts").toArray().map((r) => [r.key, this.info(r)]));
  }

  put(key: string, etag: string, r: Extracted): ExtractInfo {
    this.drop([key]);
    const text = r.status === "text" ? r.text : "";
    const starts = r.status === "text" ? r.pageStarts : null;
    const segs = r.status === "text" ? segments(text, starts).length : 0;
    for (let i = 0, n = 0; i < text.length; i += CHUNK, n++) this.sql.exec("INSERT INTO _file_extract_text (key, n, text) VALUES (?, ?, ?)", key, n, text.slice(i, i + CHUNK));
    this.sql.exec("INSERT INTO _file_extracts (key, status, chars, pages, truncated, error, retry, etag, segs, page_starts, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      key, r.status, text.length, r.status === "text" ? starts?.length ?? null : r.status === "empty" ? r.pages : null, r.status === "text" && r.truncated ? 1 : 0,
      r.status === "failed" ? r.error : null, r.status === "failed" && r.retry ? 1 : 0, etag, segs, starts ? JSON.stringify(starts) : null, new Date().toISOString());
    return this.get(key)!;
  }

  drop(keys: string[]) {
    for (const key of keys) {
      this.sql.exec("DELETE FROM _file_extracts WHERE key = ?", key);
      this.sql.exec("DELETE FROM _file_extract_text WHERE key = ?", key);
    }
  }
  move(from: string, to: string) {
    this.drop([to]);
    this.sql.exec("UPDATE _file_extracts SET key = ? WHERE key = ?", to, from);
    this.sql.exec("UPDATE _file_extract_text SET key = ? WHERE key = ?", to, from);
  }
  /** Forget everything: the board is being encrypted, and the server keeps nothing readable of it. */
  clear() {
    this.sql.exec("DELETE FROM _file_extracts");
    this.sql.exec("DELETE FROM _file_extract_text");
  }

  private range(key: string, from: number, to: number): string {
    const rows = this.sql.exec<{ n: number; text: string }>("SELECT n, text FROM _file_extract_text WHERE key = ? AND n >= ? AND n <= ? ORDER BY n", key, Math.floor(from / CHUNK), Math.floor(Math.max(to - 1, from) / CHUNK)).toArray();
    const base = Math.floor(from / CHUNK) * CHUNK;
    return rows.map((r) => r.text).join("").slice(from - base, to - base);
  }

  /** The whole text, for indexing. */
  text(key: string): string {
    return this.sql.exec<{ text: string }>("SELECT text FROM _file_extract_text WHERE key = ? ORDER BY n", key).toArray().map((r) => r.text).join("");
  }

  /** The text split for search (segments), with the PDF page each piece starts on. */
  segments(key: string): Segment[] {
    const r = this.row(key);
    if (!r || r.status !== "text") return [];
    return segments(this.text(key), r.page_starts ? (JSON.parse(r.page_starts) as number[]) : null);
  }

  /**
   * Up to `limit` characters from `offset`, or from where PDF page `page` starts. Null when the
   * file has no text. An offset past the end gives an empty slice, which says where the end is.
   */
  slice(key: string, opts: { offset?: number; page?: number; limit?: number } = {}): Slice | null {
    const r = this.row(key);
    if (!r || r.status !== "text") return null;
    const starts = r.page_starts ? (JSON.parse(r.page_starts) as number[]) : null;
    let from = Math.max(0, Math.floor(opts.offset ?? 0));
    if (opts.page !== undefined && starts) from = starts[Math.min(Math.max(Math.floor(opts.page), 1), starts.length) - 1];
    from = Math.min(from, r.chars);
    let to = Math.min(from + Math.min(Math.max(opts.limit ?? EXTRACT_SLICE, 1), EXTRACT_SLICE), r.chars);
    let text = this.range(key, from, to);
    // Never half of a character that takes two code units.
    if (to < r.chars && /[\ud800-\udbff]$/.test(text)) { text = text.slice(0, -1); to -= 1; }
    const pageAt = (at: number) => {
      if (!starts) return null;
      let p = 1;
      while (p < starts.length && starts[p] <= at) p++;
      return p;
    };
    const pageFrom = from < to ? pageAt(from) : null;
    const pageTo = from < to ? pageAt(to - 1) : null;
    if (starts && from < to) {
      // A line where each page begins, so a reader can say which page a passage is on.
      let out = "";
      let at = from;
      for (let p = pageFrom!; p <= pageTo!; p++) {
        const start = Math.max(starts[p - 1], from);
        out += text.slice(at - from, start - from);
        if (starts[p - 1] >= from) out += `[page ${p}]\n`;
        at = start;
      }
      text = out + text.slice(at - from);
    }
    return { text, from, to, chars: r.chars, pageFrom, pageTo, pages: r.pages, truncated: !!r.truncated };
  }
}

export type Segment = { n: number; offset: number; page: number | null; text: string };

/** Split text into pieces for the search indexes: a piece per PDF page, so a hit can say which page, else about SEGMENT characters cut at a paragraph or a space. */
export function segments(text: string, pageStarts: number[] | null): Segment[] {
  const cuts: { at: number; page: number | null }[] = [];
  if (pageStarts?.length) pageStarts.forEach((at, i) => cuts.push({ at, page: i + 1 }));
  else cuts.push({ at: 0, page: null });
  const out: Segment[] = [];
  cuts.forEach((c, i) => {
    const end = cuts[i + 1]?.at ?? text.length;
    // A stretch with no page break in reach (a Word file, one very long page) is cut on its own.
    for (let at = c.at; at < end;) {
      let stop = Math.min(at + SEGMENT * 2, end);
      if (stop < end) {
        const para = text.lastIndexOf("\n", stop);
        const space = text.lastIndexOf(" ", stop);
        stop = para > at + SEGMENT ? para : space > at + SEGMENT ? space : stop;
      }
      const piece = text.slice(at, stop).trim();
      if (piece) out.push({ n: out.length, offset: at, page: c.page, text: piece });
      at = stop;
    }
  });
  return out;
}

/** What a file hit shows (search-all.ts): the file's name, and for a card attachment its card and attachment id. `path` is a board file's. */
export type FileMeta = { file: string; path?: string; card?: string; att?: string; page?: number; offset: number };

/** Where a file's rows sit in the cross-board index: `f:` a board file (Docs), `a:` a card attachment (TodoAgent), then the piece's number and the key. */
export const fileRef = (scope: "f" | "a", n: number, key: string) => `${scope}:${n}:${key}`;
export const fileRefs = (scope: "f" | "a", key: string, segs: number) => Array.from({ length: segs }, (_, n) => fileRef(scope, n, key));

/** The cross-board index rows for one file's text: a row per piece, each titled with the file's name. */
export function fileEntries(scope: "f" | "a", key: string, segs: Segment[], meta: Omit<FileMeta, "page" | "offset">): Entry[] {
  return segs.map((s) => ({ kind: "file" as const, ref: fileRef(scope, s.n, key), title: meta.file, body: s.text, meta: { ...meta, ...(s.page ? { page: s.page } : {}), offset: s.offset } }));
}

const count = (n: number, one: string) => `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;

/** One file's text in a few words, for a list: what an agent can do with it. `how` names the call that reads it. */
export function describeExtract(x: ExtractState, kind: ExtractKind, how: string): string {
  const what = kind === "pdf" ? "PDF" : "Word file";
  if (x.status === "pending") return `text not extracted yet; ${how} extracts it`;
  if (x.status === "empty") return `no text found${x.pages ? ` in its ${count(x.pages, "page")}` : ""}: ${kind === "pdf" ? "it looks like a scan, and scans aren't read (no OCR)" : "the document is empty"}`;
  if (x.status === "failed") return `text not extracted: ${x.error}`;
  return `text extracted from the ${what}: ${count(x.chars, "character")}${x.pages ? `, ${count(x.pages, "page")}` : ""}${x.truncated ? `, cut at the first ${EXTRACT_MAX_CHARS.toLocaleString("en-US")} characters` : ""}; ${how} reads it`;
}

/** The line above a slice: which part this is, and how to read on. */
export function describeSlice(s: Slice, more: string): string {
  const n = (v: number) => v.toLocaleString("en-US");
  if (s.from >= s.to) return `Nothing there: the extracted text is ${n(s.chars)} characters long${s.pages ? `, ${n(s.pages)} pages` : ""}.`;
  const pages = s.pageFrom ? ` (${s.pageFrom === s.pageTo ? `page ${s.pageFrom}` : `pages ${s.pageFrom}–${s.pageTo}`} of ${s.pages})` : "";
  const whole = s.from === 0 && s.to === s.chars;
  const rest = s.to < s.chars ? ` ${n(s.chars - s.to)} more characters follow: ${more.replace("{offset}", String(s.to))}.` : s.truncated ? ` The text was cut there: only the first ${n(EXTRACT_MAX_CHARS)} characters of a file are kept.` : "";
  return `${whole ? `All ${n(s.chars)} characters` : `Characters ${n(s.from)}–${n(s.to)} of ${n(s.chars)}`}${pages}.${rest}`;
}
