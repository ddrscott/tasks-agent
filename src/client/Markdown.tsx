// Card notes as markdown, for reading. Notes are stored as plain text; this only changes how
// they're shown.
//
// It builds React elements and never touches innerHTML, so there is no HTML to sanitize: a
// <script> tag or an onerror= attribute in a note is just text. The one place note text
// reaches an attribute is a link's href, and `safeHref` only lets http, https, and mailto
// through. That matters more here than in most apps: Tasks shares an origin with the rest of
// askscottpierce.com, and a script running on it can use a remembered encryption key (README,
// "Accepted risk: a shared origin"). `npm run check:markdown` proves it.
//
// Supported: # headings, - * + and 1. lists (nested by indent), [ ] and [x] checkboxes,
// [links](https://…) and bare URLs, `code`, ``` fenced blocks, **bold**, *italic*,
// ~~strikethrough~~, > quotes, and --- rules. A single line break stays a line break.

import type { ReactNode } from "react";

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

// ------------------------------------------------------------------ inline

const INLINE = [
  "(?<tick>`+)(?<code>[^\\n]*?[^`\\n])\\k<tick>(?!`)",
  "\\[(?<label>[^\\]\\n]+)\\]\\((?<href>[^\\s)]+)\\)",
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

/** Plain text, with line breaks kept. */
function plain(s: string, key: string, out: ReactNode[]) {
  s.split("\n").forEach((part, n) => {
    if (n) out.push(<br key={`${key}b${n}`} />);
    if (part) out.push(part);
  });
}

function inline(src: string, key: string, inLink = false): ReactNode[] {
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
    } else if (g.label !== undefined) {
      const href = inLink ? null : safeHref(g.href);
      // An unsafe or relative link stays as the text the person typed.
      node = href ? link(href, inline(g.label, k, true), k) : m[0];
    } else if (g.auto !== undefined) {
      // Punctuation that ends the sentence isn't part of the URL.
      const url = g.auto.replace(/[.,;:!?'")\]]+$/, "");
      end = m.index + url.length;
      const href = inLink ? null : safeHref(url);
      node = href ? link(href, url, k) : url;
    } else if (g.b1 !== undefined || g.b2 !== undefined) {
      node = <strong key={k}>{inline(g.b1 ?? g.b2, k, inLink)}</strong>;
    } else if (g.i1 !== undefined || g.i2 !== undefined) {
      node = <em key={k}>{inline(g.i1 ?? g.i2, k, inLink)}</em>;
    } else {
      node = <del key={k}>{inline(g.del, k, inLink)}</del>;
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

const indentOf = (ws: string) => ws.replace(/\t/g, "    ").length;
const startsBlock = (l: string) => FENCE.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || ITEM.test(l);

type Ctx = { lines: string[]; onToggle?: (line: number) => void; offset: number };

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
        last.text += `\n${l.trim()}`;
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
    if (it.done === null) return <li key={k}>{inline(it.text, k)}{it.kids}</li>;
    const line = it.line + ctx.offset;
    return (
      <li key={k} className={it.done ? "md-task done" : "md-task"}>
        <input
          type="checkbox" checked={it.done} readOnly={!ctx.onToggle} aria-label={it.text.split("\n")[0]}
          onChange={() => ctx.onToggle?.(line)}
        />
        <span>{inline(it.text, k)}</span>
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

function blocks(ctx: Ctx, key: string): ReactNode[] {
  const { lines } = ctx;
  const out: ReactNode[] = [];
  let i = 0;
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
      out.push(<Tag key={k} className={`md-h${h[1].length}`}>{inline(h[2], k)}</Tag>);
      i++;
      continue;
    }

    if (RULE.test(l)) { out.push(<hr key={k} />); i++; continue; }

    if (QUOTE.test(l)) {
      const start = i;
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(QUOTE.exec(lines[i++])![1]);
      // Checkboxes in a quote are shown but not clickable: their line numbers don't map back cleanly.
      out.push(<blockquote key={k}>{blocks({ lines: inner, offset: start + ctx.offset }, `${k}q`)}</blockquote>);
      continue;
    }

    const item = ITEM.exec(l);
    if (item) {
      const res = list(ctx, i, indentOf(item[1]), k);
      out.push(res.node);
      i = res.next;
      continue;
    }

    const para = [l.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) para.push(lines[i++].trim());
    out.push(<p key={k}>{inline(para.join("\n"), k)}</p>);
  }
  return out;
}

type Props = {
  text: string;
  /** Called with the 0-based line of a checkbox the person clicked. Without it, checkboxes are read-only. */
  onToggle?: (line: number) => void;
};

export function Markdown({ text, onToggle }: Props) {
  // Split on \n only, so line numbers match `toggleTask`; a \r from pasted text is dropped per line.
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  return <div className="md">{blocks({ lines, onToggle, offset: 0 }, "b")}</div>;
}
