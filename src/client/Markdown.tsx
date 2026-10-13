// Card notes and pages as markdown, for reading. Both are stored as plain text; this only
// changes how they're shown.
//
// It builds React elements and never touches innerHTML, so there is no HTML to sanitize: a
// <script> tag or an onerror= attribute in a note is just text. Text reaches an attribute in
// two places. A link's href: `safeHref` only lets http, https, and mailto through. And, on a
// page, a link or image with no scheme: `resolveLink` turns it into a path on the page's own
// board (or refuses it), and the screen showing the page (`PageLinks`) says where that path
// opens, so what was typed never becomes an address itself. That matters more here than in
// most apps: Tasks shares an origin with the rest of askscottpierce.com, and a script running
// on it can use a remembered encryption key (README, "Accepted risk: a shared origin").
// `npm run check:markdown` proves it.
//
// Supported: # headings, - * + and 1. lists (nested by indent), [ ] and [x] checkboxes,
// [links](https://…) and bare URLs, `code`, ``` fenced blocks, **bold**, *italic*,
// ~~strikethrough~~, > quotes, --- rules, and | pipe | tables | (an alignment row of :---,
// ---:, or :---:, inline formatting in cells, \| for a pipe, empty header cells). A single
// line break stays a line break.
//
// On a page (`page` is passed) four more things: a single line break inside a paragraph is a
// space, and two trailing spaces or a backslash before it make it a break; [links](other.md),
// (../notes/x.md), (spec.pdf), and (#heading) open that page, file, or heading on the same
// board, and say so when nothing is there; ![alt](shot.png) shows an image file of the board
// (remote images stay off); headings get ids; and a --- YAML block that opens the page folds
// away as its front matter.

import type { MouseEvent, ReactNode } from "react";

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** The URL to link to, or null when it isn't an absolute http, https, or mailto URL. */
export function safeHref(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    return SAFE_PROTOCOLS.has(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

const TASK_BOX = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+\[)([ xX])(\])/;

/** Flip the checkbox on one line of a note (0-based), leaving every other character alone. */
export function toggleTask(text: string, line: number): string {
  const lines = text.split("\n");
  const l = lines[line];
  if (l === undefined) return text;
  lines[line] = l.replace(TASK_BOX, (_, a: string, box: string, c: string) => `${a}${box === " " ? "x" : " "}${c}`);
  return lines.join("\n");
}

// ------------------------------------------------------------------ pages

/** What a page's relative links and images need from whoever is showing it. */
export type PageLinks = {
  /** The page's own path on its board, like `docs/plan.md`. Relative links resolve against its folder. */
  path: string;
  /** The address a path on this board opens at (`id` is a heading's id, or ""), or null when nothing is there. */
  link(path: string, id: string): string | null;
  /** The address of an image file's bytes, or null when the path isn't an image this board shows. */
  image?(path: string): string | null;
  /** A click on a link to this board, so the app can open it in place. `path` is the page's own for a #heading. */
  onOpen?(path: string, id: string, e: MouseEvent): void;
};

const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A link with no scheme, as a path on the page's own board: `other.md` and `../notes/x.md`
 * against the folder of `from`, `/docs/x.md` from the board's top, `#heading` as a null path.
 * Null for anything that isn't one: a scheme (`javascript:`, `data:`, `C:`), a host (`//x`,
 * however it's spelled), a control character, or a path that climbs out of the board. The
 * result is only ever a path, never an address, so the caller decides where it opens.
 */
export function resolveLink(from: string, raw: string): { path: string | null; hash: string } | null {
  let s = raw.trim();
  let hash = "";
  const h = s.indexOf("#");
  if (h >= 0) { hash = s.slice(h + 1); s = s.slice(0, h); }
  const query = s.indexOf("?");
  if (query >= 0) s = s.slice(0, query);
  try { s = decodeURIComponent(s); hash = decodeURIComponent(hash); } catch { return null; }
  s = s.replace(/\\/g, "/");
  if (CONTROL.test(s) || /^[^/]*:/.test(s) || s.startsWith("//")) return null;
  if (!s) return hash ? { path: null, hash } : null;
  const parts = s.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const seg of s.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    if (!seg.trim()) return null;
    parts.push(seg);
  }
  const path = parts.join("/");
  return path && path.length <= 200 ? { path, hash } : null;
}

/** A heading's text as the word a #link names it by: lower case, punctuation dropped, spaces as dashes. */
export const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s+/g, "-");
/** The id a heading gets. Prefixed, so a heading called "body" or "location" can't shadow anything of the app's. */
export const headingId = (s: string) => `md-${slug(s) || "section"}`;

// ------------------------------------------------------------------ inline

const TITLE = '(?:\\s+"[^"\\n]*")?';
const INLINE = [
  "(?<tick>`+)(?<code>[^\\n]*?[^`\\n])\\k<tick>(?!`)",
  `!\\[(?<alt>[^\\]\\n]*)\\]\\((?<src>[^\\s)]+)${TITLE}\\)`,
  `\\[(?<label>[^\\]\\n]+)\\]\\((?<href>[^\\s)]+)${TITLE}\\)`,
  "(?<auto>\\bhttps?:\\/\\/[^\\s<>]+)",
  "\\*\\*(?=\\S)(?<b1>[^\\n]+?)(?<=\\S)\\*\\*",
  "(?<!\\w)__(?=\\S)(?<b2>[^\\n]+?)(?<=\\S)__(?!\\w)",
  "\\*(?=[^\\s*])(?<i1>[^*\\n]+?)(?<=[^\\s*])\\*",
  "(?<!\\w)_(?=[^\\s_])(?<i2>[^_\\n]+?)(?<=[^\\s_])_(?!\\w)",
  "~~(?=\\S)(?<del>[^\\n]+?)(?<=\\S)~~",
].join("|");

function link(href: string, children: ReactNode, key: string): ReactNode {
  return <a key={key} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}

/** A link or image whose target isn't on the board: the words, marked, with no address. */
function missing(children: ReactNode, path: string, key: string): ReactNode {
  return <span key={key} className="md-missing" title={`There's nothing at ${path} on this board.`}>{children}<span className="md-missing-note">not found</span></span>;
}

/** A link with no scheme, on a page: to a page, a file, or a heading of this board. Null when it isn't one. */
function pageLink(page: PageLinks, raw: string, children: ReactNode, key: string): ReactNode | null {
  const to = resolveLink(page.path, raw);
  if (!to) return null;
  const id = to.hash ? headingId(to.hash) : "";
  const path = to.path ?? page.path;
  const href = to.path === null ? `#${id}` : page.link(to.path, id);
  if (href === null) return missing(children, path, key);
  const { onOpen } = page;
  // An export's links are whole addresses and open like any other; the app's stay in the tab.
  if (/^https?:/.test(href)) return link(href, children, key);
  return <a key={key} href={href} onClick={onOpen ? (e) => onOpen(path, id, e) : undefined}>{children}</a>;
}

/** An image on a page: a file of this board that's an image. Null when the address isn't a path here (a remote image). */
function pageImage(page: PageLinks, alt: string, raw: string, key: string): ReactNode | null {
  const to = resolveLink(page.path, raw);
  if (!to || to.path === null) return null;
  const src = page.image?.(to.path) ?? null;
  // An export carries the image's bytes in the address, and a PDF is made before a lazy image would load.
  if (src) return <img key={key} className="md-img" src={src} alt={alt} loading={src.startsWith("data:") ? undefined : "lazy"} />;
  // A file that isn't an image we show (or one too big to carry in an export) is a link to it.
  const label = alt || to.path.split("/").pop()!;
  return pageLink(page, raw, label, key) ?? missing(label, to.path, key);
}

/** Plain text, with line breaks kept. */
function plain(s: string, key: string, out: ReactNode[]) {
  s.split("\n").forEach((part, n) => {
    if (n) out.push(<br key={`${key}b${n}`} />);
    if (part) out.push(part);
  });
}

function inline(src: string, key: string, page?: PageLinks, inLink = false): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(INLINE, "g");
  let at = 0;
  let n = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const g = m.groups!;
    const k = `${key}.${n++}`;
    let end = m.index + m[0].length;
    let node: ReactNode;
    if (g.code !== undefined) {
      node = <code key={k}>{g.code.trim() || g.code}</code>;
    } else if (g.alt !== undefined) {
      const remote = page && !inLink ? safeHref(g.src) : null;
      // Only on a page, and only a file of the board. A remote image is a link to it, and never loaded.
      node = remote ? link(remote, g.alt || g.src, k) : (page && !inLink ? pageImage(page, g.alt, g.src, k) : null) ?? "!";
      // Anything else is read again as a link after its "!", as it always was in a note.
      if (node === "!") end = m.index + 1;
    } else if (g.label !== undefined) {
      const href = inLink ? null : safeHref(g.href);
      // An unsafe link stays as the text the person typed; so does a relative one anywhere but a page.
      node = href ? link(href, inline(g.label, k, page, true), k) : (page && !inLink ? pageLink(page, g.href, inline(g.label, k, page, true), k) : null) ?? m[0];
    } else if (g.auto !== undefined) {
      // Punctuation that ends the sentence isn't part of the URL.
      const url = g.auto.replace(/[.,;:!?'")\]]+$/, "");
      end = m.index + url.length;
      const href = inLink ? null : safeHref(url);
      node = href ? link(href, url, k) : url;
    } else if (g.b1 !== undefined || g.b2 !== undefined) {
      node = <strong key={k}>{inline(g.b1 ?? g.b2, k, page, inLink)}</strong>;
    } else if (g.i1 !== undefined || g.i2 !== undefined) {
      node = <em key={k}>{inline(g.i1 ?? g.i2, k, page, inLink)}</em>;
    } else {
      node = <del key={k}>{inline(g.del, k, page, inLink)}</del>;
    }
    plain(src.slice(at, m.index), `${k}t`, out);
    out.push(node);
    at = end;
    re.lastIndex = end;
  }
  plain(src.slice(at), `${key}.end`, out);
  return out;
}

// ------------------------------------------------------------------ blocks

const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;

// The row under a table's header: a run of dashes per column, with colons for the alignment.
const DELIM = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
// A cell that's a number, an amount, or a date is set in the data face.
const NUMERIC = /^(?:[-+−]?[$€£¥]?\d[\d,.]*\s?(?:%|[a-zA-Z]{1,3})?|\d{4}-\d{2}-\d{2})$/;

const indentOf = (ws: string) => ws.replace(/\t/g, "    ").length;
const startsBlock = (l: string) => FENCE.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || ITEM.test(l);

type Ctx = { lines: string[]; onToggle?: (line: number) => void; fixed?: string; offset: number; page?: PageLinks; ids: Map<string, number> };

/**
 * One more source line on the end of a paragraph or a list item. In a note the line break is
 * kept. On a page it's a space, unless the line before ends in two spaces or a backslash.
 */
function addLine(ctx: Ctx, text: string, next: string): string {
  if (!ctx.page) return `${text}\n${next.trim()}`;
  const hard = /(?: {2,}|\\)$/.exec(text);
  return hard ? `${text.slice(0, hard.index).trimEnd()}\n${next.trimStart()}` : `${text.trimEnd()} ${next.trimStart()}`;
}

/** A table row's cells: split on |, with \\| as a pipe that doesn't split, and the outer pipes optional. */
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out: string[] = [];
  let cell = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cell += "|"; i++; }
    else if (s[i] === "|") { out.push(cell.trim()); cell = ""; }
    else cell += s[i];
  }
  out.push(cell.trim());
  return out;
}

/** Whether a table starts on this line: a row with a pipe, then a delimiter row with as many cells. */
function tableAt(lines: string[], i: number): boolean {
  const head = lines[i];
  const delim = lines[i + 1];
  return delim !== undefined && head.includes("|") && delim.includes("|") && DELIM.test(delim) && cells(head).length === cells(delim).length;
}

function table(ctx: Ctx, start: number, key: string): { node: ReactNode; next: number } {
  const { lines } = ctx;
  const head = cells(lines[start]);
  const align = cells(lines[start + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "md-c" : c.endsWith(":") ? "md-r" : c.startsWith(":") ? "md-l" : ""));
  const rows: string[][] = [];
  let i = start + 2;
  // A row is any line with a pipe. A blank line, another block, or plain text ends the table.
  while (i < lines.length && lines[i].includes("|") && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !QUOTE.test(lines[i])) rows.push(cells(lines[i++]));
  const cls = (n: number, text: string) => [align[n], NUMERIC.test(text) ? "md-num" : ""].filter(Boolean).join(" ") || undefined;
  const node = (
    // The box scrolls sideways, so a wide table never widens the page around it.
    <div key={key} className="md-table">
      <table>
        <thead><tr>{head.map((c, n) => <th key={n} className={align[n] || undefined}>{inline(c, `${key}h${n}`, ctx.page)}</th>)}</tr></thead>
        <tbody>
          {rows.map((row, r) => (
            // A short row is padded and a long one cut, so every row has the header's columns.
            <tr key={r}>{head.map((_, n) => <td key={n} className={cls(n, row[n] ?? "")}>{inline(row[n] ?? "", `${key}r${r}c${n}`, ctx.page)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return { node, next: i };
}

/** The line after a YAML block that opens the text (--- to --- or ...), or 0 when it doesn't open with one. */
function frontMatterEnd(lines: string[]): number {
  if (!/^---\s*$/.test(lines[0] ?? "")) return 0;
  for (let i = 1; i < lines.length; i++) {
    if (/^(?:---|\.\.\.)\s*$/.test(lines[i])) return lines.slice(1, i).some((l) => /^[\w.-]+\s*:/.test(l)) ? i + 1 : 0;
  }
  return 0;
}

/** A page's front matter, folded: its top-level keys and what they're set to, as written. */
function frontMatter(lines: string[]): ReactNode {
  const pairs: { key: string; value: string }[] = [];
  for (const l of lines) {
    const m = /^([\w.-]+)\s*:\s*(.*)$/.exec(l);
    if (m) pairs.push({ key: m[1], value: m[2].replace(/^(["'])(.*)\1$/, "$2") });
    else if (l.trim() && !/^\s*#/.test(l) && pairs.length) pairs[pairs.length - 1].value += `${pairs[pairs.length - 1].value ? "\n" : ""}${l.trim()}`;
  }
  return (
    <details key="meta" className="md-meta">
      <summary><span className="md-meta-mark">//</span> FRONT_MATTER <span className="md-meta-count">{pairs.length} {pairs.length === 1 ? "field" : "fields"}</span></summary>
      <dl>{pairs.map((p, n) => <div key={n}><dt>{p.key}</dt><dd>{p.value}</dd></div>)}</dl>
    </details>
  );
}

function list(ctx: Ctx, start: number, base: number, key: string): { node: ReactNode; next: number } {
  const { lines } = ctx;
  const ordered = /\d/.test(ITEM.exec(lines[start])![2]);
  const first = ordered ? parseInt(ITEM.exec(lines[start])![2], 10) : 1;
  const items: { text: string; line: number; done: boolean | null; kids: ReactNode[] }[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      // A blank line ends the list unless more of it follows.
      let j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      const m = j < lines.length ? ITEM.exec(lines[j]) : null;
      if (!m || indentOf(m[1]) < base) break;
      i = j;
      continue;
    }
    const m = ITEM.exec(l);
    const last = items[items.length - 1];
    if (!m) {
      // Indented text under an item belongs to it.
      if (last && indentOf(/^\s*/.exec(l)![0]) > base && !FENCE.test(l)) {
        last.text = addLine(ctx, last.text, l);
        i++;
        continue;
      }
      break;
    }
    const ind = indentOf(m[1]);
    if (ind < base) break;
    if (ind >= base + 2 && last) {
      const sub = list(ctx, i, ind, `${key}.${items.length}s${last.kids.length}`);
      last.kids.push(sub.node);
      i = sub.next;
      continue;
    }
    if (/\d/.test(m[2]) !== ordered) break;
    const t = TASK.exec(m[3]);
    items.push({ text: t ? t[2] : m[3], line: i, done: t ? t[1] !== " " : null, kids: [] });
    i++;
  }
  const lis = items.map((it, n) => {
    const k = `${key}.${n}`;
    if (it.done === null) return <li key={k}>{inline(it.text, k, ctx.page)}{it.kids}</li>;
    const line = it.line + ctx.offset;
    return (
      // With nothing to call, the box is disabled, not just read-only: a read-only checkbox looks
      // live and does nothing when clicked. `fixed` says why, on hover, for whoever tries.
      <li key={k} className={it.done ? "md-task done" : "md-task"} title={ctx.onToggle ? undefined : ctx.fixed}>
        <input
          type="checkbox" checked={it.done} disabled={!ctx.onToggle} aria-label={it.text.split("\n")[0]}
          onChange={() => ctx.onToggle?.(line)}
        />
        <span>{inline(it.text, k, ctx.page)}</span>
        {it.kids}
      </li>
    );
  });
  const tasks = items.length > 0 && items.every((it) => it.done !== null);
  const node = ordered
    ? <ol key={key} start={first === 1 ? undefined : first} className={tasks ? "md-tasks" : undefined}>{lis}</ol>
    : <ul key={key} className={tasks ? "md-tasks" : undefined}>{lis}</ul>;
  return { node, next: i };
}

function blocks(ctx: Ctx, key: string, from = 0): ReactNode[] {
  const { lines } = ctx;
  const out: ReactNode[] = [];
  let i = from;
  while (i < lines.length) {
    const l = lines[i];
    const k = `${key}${i}`;
    if (!l.trim()) { i++; continue; }

    const fence = FENCE.exec(l);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i].trim().startsWith(fence[1]) && /^\s*(`+|~+)\s*$/.test(lines[i]))) body.push(lines[i++]);
      i++; // the closing fence, or one past the end when it was never closed
      out.push(<pre key={k}><code>{body.join("\n")}</code></pre>);
      continue;
    }

    const h = HEADING.exec(l);
    if (h) {
      // Notes sit under the card title, so the biggest heading here is an h3.
      const Tag = `h${Math.min(h[1].length + 2, 6)}` as "h3" | "h4" | "h5" | "h6";
      let id: string | undefined;
      if (ctx.page) {
        // What #links name the heading by: its words without the markup. A second "Notes" is notes-1.
        const base = headingId(h[2].replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1"));
        const seen = ctx.ids.get(base) ?? 0;
        ctx.ids.set(base, seen + 1);
        id = seen ? `${base}-${seen}` : base;
      }
      out.push(<Tag key={k} id={id} className={`md-h${h[1].length}`}>{inline(h[2], k, ctx.page)}</Tag>);
      i++;
      continue;
    }

    if (RULE.test(l)) { out.push(<hr key={k} />); i++; continue; }

    if (QUOTE.test(l)) {
      const start = i;
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(QUOTE.exec(lines[i++])![1]);
      // Checkboxes in a quote are shown but not clickable: their line numbers don't map back cleanly.
      out.push(<blockquote key={k}>{blocks({ lines: inner, fixed: ctx.fixed, offset: start + ctx.offset, page: ctx.page, ids: ctx.ids }, `${k}q`)}</blockquote>);
      continue;
    }

    if (tableAt(lines, i)) {
      const res = table(ctx, i, k);
      out.push(res.node);
      i = res.next;
      continue;
    }

    const item = ITEM.exec(l);
    if (item) {
      const res = list(ctx, i, indentOf(item[1]), k);
      out.push(res.node);
      i = res.next;
      continue;
    }

    let para = ctx.page ? l.trimStart() : l.trim();
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !tableAt(lines, i)) para = addLine(ctx, para, lines[i++]);
    out.push(<p key={k}>{inline(para.trimEnd(), k, ctx.page)}</p>);
  }
  return out;
}

type Props = {
  text: string;
  /** Called with the 0-based line of a checkbox the person clicked. Without it, checkboxes are disabled. */
  onToggle?: (line: number) => void;
  /** Why the checkboxes can't be ticked, for the tooltip on each one. Only used without `onToggle`. */
  fixed?: string;
  /**
   * The text is a page, not a card's notes: paragraphs reflow, links and images with no scheme
   * resolve against the page's folder on its board, headings get ids, and front matter folds.
   */
  page?: PageLinks;
};

export function Markdown({ text, onToggle, fixed, page }: Props) {
  // Split on \n only, so line numbers match `toggleTask`; a \r from pasted text is dropped per line.
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  // Front matter is skipped, not cut out, so every line after it keeps its number.
  const body = page ? frontMatterEnd(lines) : 0;
  return (
    <div className="md">
      {body > 0 && frontMatter(lines.slice(1, body - 1))}
      {blocks({ lines, onToggle, fixed, offset: 0, page, ids: new Map() }, "b", body)}
    </div>
  );
}
