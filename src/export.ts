// Page exports (// EXPORT in the README): a page as a standalone HTML document, a Word
// document (.docx), or a PDF; a folder of pages as a zip. One renderer for all of them: the
// same Markdown component the app draws pages with (src/client/Markdown.tsx) is rendered
// to static HTML for the HTML and PDF exports, and walked as a React element tree for the
// DOCX, so what you print is what you saw. The DOCX is written by hand (WordprocessingML in
// a zip: fflate), which keeps a 17 MB library out of the Worker. PDF needs the Browser
// Rendering binding (BROWSER in wrangler.jsonc); without it the HTML export prints, and
// the app's Print button opens it and calls print.

import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { strToU8, zipSync } from "fflate";
import { Markdown } from "./client/Markdown";

export type ExportFormat = "html" | "docx" | "pdf";
export const EXPORT_FORMATS: ExportFormat[] = ["html", "docx", "pdf"];
export const EXPORT_TYPES: Record<ExportFormat, string> = {
  html: "text/html; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The page's title: its first heading, else its file name without the extension. */
export function pageTitle(path: string, text: string): string {
  const h = text.match(/^#{1,6}[ \t]+(.+?)[ \t#]*$/m);
  return (h?.[1] ?? path.split("/").pop()?.replace(/\.[a-z0-9]+$/i, "") ?? path).slice(0, 200);
}

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 48px 56px; max-width: 820px; font: 15px/1.6 -apple-system, "Segoe UI", Inter, Roboto, sans-serif; color: #111; background: #fff; }
.md > :first-child { margin-top: 0; }
.md p, .md ul, .md ol, .md pre, .md blockquote { margin: 0 0 12px; }
.md h3, .md h4, .md h5, .md h6 { margin: 28px 0 8px; line-height: 1.25; font-weight: 650; }
.md .md-h1 { font-size: 28px; padding-bottom: 8px; border-bottom: 2px solid #E85D00; }
.md .md-h2 { font-size: 22px; }
.md .md-h3 { font-size: 18px; }
.md .md-h4, .md .md-h5, .md .md-h6 { font-size: 15px; }
.md code { font: 13px/1.5 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; background: #f3f3f1; padding: 1px 4px; }
.md pre { background: #f3f3f1; padding: 12px 14px; overflow-x: auto; border: 1px solid #e3e3df; }
.md pre code { background: none; padding: 0; }
.md blockquote { border-left: 2px solid #E85D00; margin-left: 0; padding: 2px 0 2px 14px; color: #444; }
.md hr { border: 0; border-top: 1px solid #ddd; margin: 20px 0; }
.md a { color: #b84800; }
.md ul, .md ol { padding-left: 24px; }
.md li { margin: 2px 0; }
.md .md-tasks { list-style: none; padding-left: 4px; }
.md .md-task { display: flex; gap: 8px; align-items: baseline; }
.md .md-task input { margin: 0; accent-color: #E85D00; }
.md .md-task.done > span { color: #777; text-decoration: line-through; }
.foot { margin-top: 40px; padding-top: 10px; border-top: 1px solid #ddd; font: 11px/1.5 "JetBrains Mono", ui-monospace, monospace; color: #777; }
@media print { body { padding: 0; max-width: none; } .foot { display: none; } @page { margin: 18mm 20mm; } }
`;

/** The page as one HTML document: the app's renderer, light styles, nothing loaded from anywhere. */
export function pageHtml(path: string, text: string, source?: { board: string; by: string; at: string }): string {
  const title = pageTitle(path, text);
  const body = renderToStaticMarkup(createElement(Markdown, { text, fixed: "" }));
  const foot = source ? `<div class="foot">${esc(path)} · ${esc(source.board)} · last changed by ${esc(source.by)}, ${esc(source.at)}</div>` : "";
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}${foot}</body></html>\n`;
}

// ---------- DOCX ----------

type Run = { text: string; b?: boolean; i?: boolean; strike?: boolean; code?: boolean; href?: string; br?: boolean };
type Para = { style?: string; runs: Run[]; indent?: number; bullet?: string; code?: boolean; rule?: boolean };

const x = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

/** The element tree the Markdown component makes, flattened to paragraphs of runs. */
function paragraphsOf(text: string): Para[] {
  const root = createElement(Markdown, { text, fixed: "" });
  const paras: Para[] = [];
  const kids = (el: ReactElement): ReactNode[] => {
    const c = (el.props as { children?: ReactNode }).children;
    return Array.isArray(c) ? c : c === undefined || c === null ? [] : [c];
  };
  // The component itself is a function element; call it to get the div it returns.
  const rendered = (root.type as (p: unknown) => ReactElement)(root.props);
  const inlineOf = (node: ReactNode, fmt: Omit<Run, "text">, out: Run[]) => {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (typeof node === "string" || typeof node === "number") { out.push({ ...fmt, text: String(node) }); return; }
    if (Array.isArray(node)) { for (const n of node) inlineOf(n, fmt, out); return; }
    if (!isValidElement(node)) return;
    const el = node as ReactElement;
    const t = el.type as string;
    const props = el.props as Record<string, unknown>;
    if (t === "br") { out.push({ ...fmt, text: "", br: true }); return; }
    if (t === "strong") { for (const k of kids(el)) inlineOf(k, { ...fmt, b: true }, out); return; }
    if (t === "em") { for (const k of kids(el)) inlineOf(k, { ...fmt, i: true }, out); return; }
    if (t === "del") { for (const k of kids(el)) inlineOf(k, { ...fmt, strike: true }, out); return; }
    if (t === "code") { for (const k of kids(el)) inlineOf(k, { ...fmt, code: true }, out); return; }
    if (t === "a") { for (const k of kids(el)) inlineOf(k, { ...fmt, href: typeof props.href === "string" ? props.href : undefined }, out); return; }
    if (t === "input") { out.push({ ...fmt, text: props.checked ? "☒ " : "☐ " }); return; }
    for (const k of kids(el)) inlineOf(k, fmt, out);
  };
  const blockOf = (node: ReactNode, depth: number, bullet: string | null) => {
    if (node === null || node === undefined || typeof node === "boolean") return;
    if (Array.isArray(node)) { for (const n of node) blockOf(n, depth, bullet); return; }
    if (typeof node === "string" || typeof node === "number") { paras.push({ runs: [{ text: String(node) }], indent: depth }); return; }
    if (!isValidElement(node)) return;
    const el = node as ReactElement;
    const t = el.type as string;
    const props = el.props as Record<string, unknown>;
    if (/^h[1-6]$/.test(t)) {
      const level = Number((typeof props.className === "string" && /md-h(\d)/.exec(props.className)?.[1]) ?? t[1]);
      const runs: Run[] = [];
      for (const k of kids(el)) inlineOf(k, {}, runs);
      paras.push({ style: `Heading${level}`, runs });
      return;
    }
    if (t === "p") {
      const runs: Run[] = [];
      for (const k of kids(el)) inlineOf(k, {}, runs);
      paras.push({ runs, indent: depth, bullet: bullet ?? undefined });
      return;
    }
    if (t === "pre") {
      const runs: Run[] = [];
      for (const k of kids(el)) inlineOf(k, { code: true }, runs);
      const lines = runs.map((r) => r.text).join("").split("\n");
      for (const line of lines) paras.push({ style: "Code", runs: [{ text: line, code: true }], code: true });
      return;
    }
    if (t === "hr") { paras.push({ runs: [], rule: true }); return; }
    if (t === "blockquote") { for (const k of kids(el)) blockOf(k, depth + 1, null); paras.filter((p) => !p.style).slice(-1).forEach((p) => { p.style ??= "Quote"; }); return; }
    if (t === "ul" || t === "ol") {
      let n = typeof props.start === "number" ? props.start : 1;
      for (const li of kids(el)) {
        if (!isValidElement(li)) continue;
        const item = li as ReactElement;
        const mark = t === "ol" ? `${n++}.` : "•";
        // The item's own text first (inline nodes and the task span), then nested lists as blocks.
        const runs: Run[] = [];
        const nested: ReactNode[] = [];
        for (const k of kids(item)) {
          if (isValidElement(k) && ((k as ReactElement).type === "ul" || (k as ReactElement).type === "ol")) nested.push(k);
          else if (Array.isArray(k)) for (const kk of k) { if (isValidElement(kk) && ((kk as ReactElement).type === "ul" || (kk as ReactElement).type === "ol")) nested.push(kk); else inlineOf(kk, {}, runs); }
          else inlineOf(k, {}, runs);
        }
        paras.push({ runs, indent: depth, bullet: mark });
        for (const sub of nested) blockOf(sub, depth + 1, null);
      }
      return;
    }
    for (const k of kids(el)) blockOf(k, depth, bullet);
  };
  for (const k of kids(rendered)) blockOf(k, 0, null);
  return paras;
}

/** A Word document of the page: headings, paragraphs, lists as bulleted paragraphs, code, quotes, links. */
export function pageDocx(path: string, text: string): Uint8Array {
  const title = pageTitle(path, text);
  const paras = paragraphsOf(text);
  const rels: string[] = [];
  const relId = (href: string) => { rels.push(href); return `rId${rels.length + 1}`; };
  const runXml = (r: Run): string => {
    if (r.br) return "<w:r><w:br/></w:r>";
    const pr = [r.b ? "<w:b/>" : "", r.i ? "<w:i/>" : "", r.strike ? "<w:strike/>" : "", r.code ? '<w:rFonts w:ascii="JetBrains Mono" w:hAnsi="JetBrains Mono" w:cs="Courier New"/><w:sz w:val="19"/>' : ""].join("");
    const run = `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ""}<w:t xml:space="preserve">${x(r.text)}</w:t></w:r>`;
    return r.href ? `<w:hyperlink r:id="${relId(r.href)}"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/>${pr}</w:rPr><w:t xml:space="preserve">${x(r.text)}</w:t></w:r></w:hyperlink>` : run;
  };
  const body = paras.map((p) => {
    if (p.rule) return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BBBBBB"/></w:pBdr></w:pPr></w:p>';
    const ind = (p.indent ?? 0) * 360 + (p.bullet ? 360 : 0);
    const pr = [
      p.style ? `<w:pStyle w:val="${p.style}"/>` : "",
      ind ? `<w:ind w:left="${ind}"${p.bullet ? ` w:hanging="360"` : ""}/>` : "",
    ].join("");
    const bullet = p.bullet ? `<w:r><w:t xml:space="preserve">${x(p.bullet)}\t</w:t></w:r>` : "";
    return `<w:p>${pr ? `<w:pPr>${pr}</w:pPr>` : ""}${bullet}${p.runs.map(runXml).join("")}</w:p>`;
  }).join("");
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1200" w:right="1200" w:bottom="1200" w:left="1200" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const heading = (n: number, size: number, extra = "") => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="${n === 1 ? 0 : 320}" w:after="120"/>${extra}</w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
${heading(1, 44, '<w:pBdr><w:bottom w:val="single" w:sz="12" w:space="4" w:color="E85D00"/></w:pBdr>')}${heading(2, 34)}${heading(3, 28)}${heading(4, 24)}${heading(5, 22)}${heading(6, 22)}
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="F3F3F1"/><w:ind w:left="200"/></w:pPr><w:rPr><w:rFonts w:ascii="JetBrains Mono" w:hAnsi="JetBrains Mono" w:cs="Courier New"/><w:sz w:val="19"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="E85D00"/></w:pBdr><w:ind w:left="360"/></w:pPr><w:rPr><w:color w:val="444444"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="B84800"/><w:u w:val="single"/></w:rPr></w:style>
</w:styles>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${rels.map((href, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${x(href).replace(/"/g, "&quot;")}" TargetMode="External"/>`).join("")}</Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(title)}</dc:title><dc:creator>Tasks</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>`;
  return zipSync({
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rootRels),
    "docProps/core.xml": strToU8(core),
    "word/document.xml": strToU8(document),
    "word/styles.xml": strToU8(styles),
    "word/_rels/document.xml.rels": strToU8(docRels),
  }, { level: 6 });
}

// ---------- PDF ----------

/** The page as a PDF, through Browser Rendering. Null without the binding: the HTML export prints. */
export async function pagePdf(env: Env, html: string): Promise<Uint8Array | null> {
  const browser = env.BROWSER;
  if (!browser) return null;
  const { default: puppeteer } = await import("@cloudflare/puppeteer");
  const b = await puppeteer.launch(browser);
  try {
    const page = await b.newPage();
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({ format: "letter", printBackground: true, margin: { top: "18mm", right: "20mm", bottom: "18mm", left: "20mm" } });
    return new Uint8Array(pdf);
  } finally {
    await b.close();
  }
}

// ---------- zip ----------

/** A zip of pages. `as` html wraps each page in the HTML export; otherwise the text goes in as is. */
export function pagesZip(pages: { path: string; text: string }[], as: "md" | "html"): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const p of pages) {
    const name = as === "html" ? p.path.replace(/\.[a-z0-9]+$/i, "") + ".html" : p.path;
    files[name] = strToU8(as === "html" ? pageHtml(p.path, p.text) : p.text);
  }
  return zipSync(files, { level: 6 });
}
