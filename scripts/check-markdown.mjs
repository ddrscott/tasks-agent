#!/usr/bin/env node
// Check the notes and pages renderer (src/client/Markdown.tsx): that markdown comes out as the
// right elements, that a page's relative links only ever reach its own board, and that nothing
// in a note or a page can run script. Exits 1 on the first group of failures.
//
//   npm run check:markdown        # -v prints the rendered HTML for the hostile note

import { build } from "esbuild";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;
// Bundle into node_modules so the bundle's own `react` imports resolve from this repo.
const dir = join(root, "node_modules", ".cache", "check-markdown");
const outfile = join(dir, `markdown-${process.pid}.mjs`);
await build({
  entryPoints: [join(root, "src/client/Markdown.tsx")],
  outfile, bundle: true, format: "esm", platform: "node", jsx: "automatic",
  external: ["react", "react-dom", "react/jsx-runtime"], logLevel: "error",
});
const { Markdown, safeHref, toggleTask, resolveLink, headingId } = await import(pathToFileURL(outfile).href);
rmSync(dir, { recursive: true, force: true });

const { createRequire } = await import("node:module");
const req = createRequire(join(root, "package.json"));
const { createElement } = req("react");
const { renderToStaticMarkup } = req("react-dom/server");
const html = (text) => renderToStaticMarkup(createElement(Markdown, { text }));

let failed = 0;
function check(name, ok, detail = "") {
  if (ok) return console.log(`ok   ${name}`);
  failed++;
  console.log(`FAIL ${name}${detail ? `\n     ${detail}` : ""}`);
}
const has = (name, text, want) => {
  const out = html(text);
  check(name, out.includes(want), `wanted ${want}\n     got    ${out}`);
};

// ---------------------------------------------------------------- what renders

has("heading", "# Title", '<h3 class="md-h1">Title</h3>');
has("smaller heading", "### Third", '<h5 class="md-h3">Third</h5>');
has("bullet list", "- one\n- two", "<ul><li>one</li><li>two</li></ul>");
has("numbered list", "1. one\n2. two", "<ol><li>one</li><li>two</li></ol>");
has("numbered list keeps its start", "3. three\n4. four", '<ol start="3">');
has("nested list", "- a\n  - b", "<ul><li>a<ul><li>b</li></ul></li></ul>");
has("open checkbox", "- [ ] todo", '<input type="checkbox" disabled="" aria-label="todo"/>');
has("checked checkbox", "- [x] did it", 'checked=""');
has("bold", "a **b** c", "a <strong>b</strong> c");
has("italic", "a *b* c", "a <em>b</em> c");
has("bold with italic inside", "**a *b* c**", "<strong>a <em>b</em> c</strong>");
has("underscore italic", "an _odd_ one", "<em>odd</em>");
has("snake_case is left alone", "call some_function_name now", "call some_function_name now");
has("math is left alone", "2 * 3 * 4", "2 * 3 * 4");
has("strikethrough", "~~no~~", "<del>no</del>");
has("inline code", "run `npm test` now", "run <code>npm test</code> now");
has("inline code keeps markup literal", "`**not bold**`", "<code>**not bold**</code>");
has("code block", "```sh\nnpm run build\n**x**\n```", "<pre><code>npm run build\n**x**</code></pre>");
has("unclosed code block", "```\nstill code", "<pre><code>still code</code></pre>");
has("quote", "> said", "<blockquote><p>said</p></blockquote>");
has("rule", "a\n\n---\n\nb", "<hr/>");
has("line break kept", "one\ntwo", "<p>one<br/>two</p>");
has("link", "[site](https://example.com/a)", '<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">site</a>');
has("bare URL", "see https://example.com/a.", '<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">https://example.com/a</a>.');
has("mailto", "[mail](mailto:a@example.com)", 'href="mailto:a@example.com"');
has("status line survives", "STATUS: done — lead, 2026-10-03 10:42", "<p>STATUS: done — lead, 2026-10-03 10:42</p>");

// ---------------------------------------------------------------- tables

has("table", "| A | B |\n| --- | --- |\n| 1 | two |", '<div class="md-table"><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td class="md-num">1</td><td>two</td></tr></tbody></table></div>');
has("table without outer pipes", "A | B\n--- | ---\nc | d", "<tbody><tr><td>c</td><td>d</td></tr></tbody>");
has("table alignment", "| a | b | c |\n| :--- | ---: | :---: |\n| x | y | z |", '<th class="md-l">a</th><th class="md-r">b</th><th class="md-c">c</th>');
has("table alignment on cells", "| a | b |\n| --- | ---: |\n| x | $1,200.50 |", '<td class="md-r md-num">$1,200.50</td>');
has("table with an empty header", "| | |\n| --- | --- |\n| Code | here |", "<thead><tr><th></th><th></th></tr></thead><tbody><tr><td>Code</td><td>here</td></tr></tbody>");
has("inline formatting in a cell", "| a |\n| --- |\n| **b** `c` [d](https://example.com/) |", '<td><strong>b</strong> <code>c</code> <a href="https://example.com/"');
has("escaped pipe in a cell", "| a | b |\n| --- | --- |\n| x \\| y | z |", "<td>x | y</td><td>z</td>");
has("short row is padded", "| a | b |\n| --- | --- |\n| only |", "<tr><td>only</td><td></td></tr>");
has("long row is cut", "| a |\n| --- |\n| x | extra |", "<tbody><tr><td>x</td></tr></tbody>");
has("table ends a paragraph", "before\n| a |\n| --- |\n| x |\nafter", "<p>before</p><div class=\"md-table\">");
has("text after a table is a paragraph", "| a |\n| --- |\n| x |\nafter", "</div><p>after</p>");
has("a pipe in a sentence is not a table", "a | b\nc | d", "<p>a | b<br/>c | d</p>");
has("a rule under a line is not a table", "a\n---", "<p>a</p><hr/>");
has("raw HTML in a cell is text", "| a |\n| --- |\n| <img src=x onerror=alert(1)> |", "<td>&lt;img src=x onerror=alert(1)&gt;</td>");

// ---------------------------------------------------------------- pages

// A page on a board that has these paths. `link` is the only place an address is made.
const BOARD_FILES = new Set(["docs/plan.md", "docs/other.md", "docs/spec.pdf", "docs/shot.png", "notes/x.md", "top.md"]);
const page = {
  path: "docs/plan.md",
  link: (path, id) => (BOARD_FILES.has(path) ? `/tasks/pages?board=b1&path=${encodeURIComponent(path)}${id ? `#${id}` : ""}` : null),
  image: (path) => (path.endsWith(".png") && BOARD_FILES.has(path) ? `/tasks/api/files/${path.split("/").map(encodeURIComponent).join("/")}?board=b1` : null),
};
const pageHtmlOf = (text) => renderToStaticMarkup(createElement(Markdown, { text, page }));
const onPage = (name, text, want) => {
  const got = pageHtmlOf(text);
  check(name, got.includes(want), `wanted ${want}\n     got    ${got}`);
};

onPage("page: a line break in a paragraph is a space", "one\ntwo\nthree", "<p>one two three</p>");
onPage("page: two trailing spaces break the line", "one  \ntwo", "<p>one<br/>two</p>");
onPage("page: a backslash breaks the line", "one\\\ntwo", "<p>one<br/>two</p>");
onPage("page: bold runs across a wrapped line", "a **b\nc** d", "<p>a <strong>b c</strong> d</p>");
onPage("page: a wrapped list item reflows", "- one\n  two\n- three", "<ul><li>one two</li><li>three</li></ul>");
onPage("page: a quote reflows", "> one\n> two", "<blockquote><p>one two</p></blockquote>");
has("note: a line break is still a line break", "one\ntwo  \nthree", "<p>one<br/>two<br/>three</p>");
has("note: a wrapped list item keeps its break", "- one\n  two", "<li>one<br/>two</li>");

onPage("page: link to a sibling page", "[other](other.md)", '<a href="/tasks/pages?board=b1&amp;path=docs%2Fother.md">other</a>');
onPage("page: link up and over", "[x](../notes/x.md)", 'href="/tasks/pages?board=b1&amp;path=notes%2Fx.md"');
onPage("page: link from the top of the board", "[top](/top.md)", 'href="/tasks/pages?board=b1&amp;path=top.md"');
onPage("page: link to a file", "[spec](spec.pdf)", 'href="/tasks/pages?board=b1&amp;path=docs%2Fspec.pdf"');
onPage("page: link to a heading on another page", "[x](other.md#The%20Plan!)", 'path=docs%2Fother.md#md-the-plan"');
onPage("page: link to a heading on this page", "[up](#what-done-looks-like)", '<a href="#md-what-done-looks-like">up</a>');
onPage("page: a link with a title", '[other](other.md "the other one")', 'path=docs%2Fother.md">other</a>');
onPage("page: a missing target says so", "[gone](nope.md)", '<span class="md-missing" title="There&#x27;s nothing at docs/nope.md on this board.">gone<span class="md-missing-note">not found</span></span>');
onPage("page: an http link still opens in a new tab", "[site](https://example.com/a)", '<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">site</a>');
has("note: a relative link stays text", "[other](other.md)", "<p>[other](other.md)</p>");

onPage("page: headings get ids", "# What done looks like", '<h3 id="md-what-done-looks-like" class="md-h1">What done looks like</h3>');
onPage("page: a second heading of the same name", "## Notes\n\n## Notes", 'id="md-notes-1"');
onPage("page: a heading's id leaves out its markup", "## The `code` and [a link](https://example.com)", 'id="md-the-code-and-a-link"');
has("note: headings have no id", "# Title", '<h3 class="md-h1">Title</h3>');
check("headingId can't name anything of the app's", ["body", "location", "__proto__", "constructor", ""].every((h) => headingId(h).startsWith("md-")));

onPage("page: an image file of the board", "![a shot](shot.png)", '<img class="md-img" src="/tasks/api/files/docs/shot.png?board=b1" alt="a shot" loading="lazy"/>');
onPage("page: a file that isn't an image is a link", "![the spec](spec.pdf)", 'path=docs%2Fspec.pdf">the spec</a>');
onPage("page: a missing image says so", "![gone](nope.png)", 'class="md-missing"');
check("page: a remote image stays off", !pageHtmlOf("![x](https://example.com/x.png) ![y](//example.com/y.png) ![z](data:image/png;base64,AAAA)").includes("<img"));
check("note: no images at all", !html("![a shot](shot.png) ![x](https://example.com/x.png)").includes("<img"));

onPage("page: front matter folds away", "---\ntitle: The plan\ntags: [a, b]\n---\n\n# Plan", '<details class="md-meta"><summary><span class="md-meta-mark">//</span> FRONT_MATTER <span class="md-meta-count">2 fields</span></summary><dl><div><dt>title</dt><dd>The plan</dd></div><div><dt>tags</dt><dd>[a, b]</dd></div></dl></details><h3 id="md-plan"');
check("page: front matter leaves no rule and no key: value paragraph", !/<hr|<p>title/.test(pageHtmlOf("---\ntitle: The plan\n---\n\nbody")));
onPage("page: a rule that isn't front matter is a rule", "---\n\nbody\n\n---", "<hr/><p>body</p><hr/>");
has("note: front matter is not read", "---\ntitle: x\n---", "<hr/>");

// Which source line each checkbox toggles, by walking the element tree and clicking every box.
function toggled(text, props = {}) {
  const hit = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    if (node.type === "input") node.props.onChange();
    walk(node.props?.children);
  };
  walk(Markdown({ text, onToggle: (line) => hit.push(line), ...props }));
  return hit;
}
const BOXES = "---\ntitle: x\n---\nwrapped\nprose here\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- [ ] first\n  wrapped on\n- [x] second\n\n> - [ ] quoted\n\n1. [ ] third";
const boxLines = BOXES.split("\n").flatMap((l, n) => (/^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(l) ? [n] : []));
check("page: each checkbox toggles its own source line", JSON.stringify(toggled(BOXES, { page })) === JSON.stringify(boxLines), `${toggled(BOXES, { page })} vs ${boxLines}`);
check("note: each checkbox toggles its own source line", JSON.stringify(toggled(BOXES)) === JSON.stringify(boxLines), `${toggled(BOXES)} vs ${boxLines}`);
check("page: toggleTask flips the line a box names", boxLines.every((n) => toggleTask(BOXES, n).split("\n")[n] !== BOXES.split("\n")[n]));

check("toggleTask checks a box", toggleTask("a\n- [ ] b\n- [ ] c", 1) === "a\n- [x] b\n- [ ] c");
check("toggleTask unchecks a box", toggleTask("1. [X] b", 0) === "1. [ ] b");
check("toggleTask ignores other lines", toggleTask("plain [ ] text", 0) === "plain [ ] text");

// ---------------------------------------------------------------- what can't run

for (const bad of [
  "javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "java\nscript:alert(1)",
  "\u0001javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "blob:https://x/1",
  "file:///etc/passwd", "//evil.example/x", "/tasks/api/tokens", "evil.example", "",
]) check(`safeHref refuses ${JSON.stringify(bad)}`, safeHref(bad) === null);
check("safeHref allows https", safeHref("https://example.com/") === "https://example.com/");

// A relative link is a path on the page's board or nothing. None of these may come back as one.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
for (const [raw, want] of [
  ["other.md", { path: "docs/other.md", hash: "" }],
  ["./other.md", { path: "docs/other.md", hash: "" }],
  ["../notes/x.md", { path: "notes/x.md", hash: "" }],
  ["sub/deep.md#part", { path: "docs/sub/deep.md", hash: "part" }],
  ["/top.md", { path: "top.md", hash: "" }],
  ["my%20file.pdf", { path: "docs/my file.pdf", hash: "" }],
  ["other.md?x=1", { path: "docs/other.md", hash: "" }],
  ["#heading", { path: null, hash: "heading" }],
]) check(`resolveLink ${JSON.stringify(raw)}`, same(resolveLink("docs/plan.md", raw), want), JSON.stringify(resolveLink("docs/plan.md", raw)));
const CLIMBS = [
  "javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "java%73cript:alert(1)", "javascript%3Aalert(1)", "java\tscript:alert(1)",
  "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "blob:https://x/1", "file:///etc/passwd", "C:/Windows", "x:y",
  "//evil.example/x", "/\\evil.example/x", "\\\\evil.example\\x", "/%2Fevil.example/x", "%2F%2Fevil.example/x", "///evil.example",
  "../../x.md", "../../../etc/passwd", "..", "../", "..\\..\\x.md", "%2e%2e/%2e%2e/x.md", "a/../../../x.md", "/../x.md", "..%2F..%2Fx.md",
  "%00.md", "a%0Ab.md", "%E0%A4%A", "", "#", "?x=1", " / ",
];
for (const bad of CLIMBS) check(`resolveLink refuses ${JSON.stringify(bad)}`, resolveLink("docs/plan.md", bad) === null, JSON.stringify(resolveLink("docs/plan.md", bad)));
check("resolveLink can't climb out from the top folder", resolveLink("top.md", "../x.md") === null);
check("resolveLink refuses a path over 200 characters", resolveLink("a.md", `${"x".repeat(201)}.md`) === null);

// The same list as links and images on a page: every address in the output is one `link` or
// `image` made from a path, or the page's own heading.
const pageAttack = pageHtmlOf(CLIMBS.filter((c) => c && !/\s/.test(c)).map((c) => `[link](${c}) ![image](${c})`).join("\n\n"));
const pageAddrs = [...pageAttack.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => m[1]);
check("hostile page: no link or image leaves the board", pageAddrs.every((a) => /^\/tasks\/(pages\?board=b1&amp;path=|api\/files\/)/.test(a) || /^#md-/.test(a)), pageAddrs.join(" "));
check("hostile page: nothing unsafe resolved at all", pageAddrs.length === 0, pageAddrs.join(" "));
check("hostile page: no image element", !pageAttack.includes("<img"));

const hostile = [
  "<script>alert('xss')</script>",
  '<img src=x onerror="alert(1)">',
  "<svg onload=alert(1)>",
  '<a href="javascript:alert(1)">raw anchor</a>',
  "<iframe src=\"javascript:alert(1)\"></iframe>",
  "[click me](javascript:alert(1))",
  "[click me](JaVaScRiPt:alert(1))",
  "[click me](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "[click me](vbscript:msgbox(1))",
  '[quote break](https://example.com/"onmouseover="alert(1))',
  "[**bold** <img src=x onerror=alert(1)>](https://example.com)",
  "- [ ] <script>alert(2)</script>",
  "# <script>alert(3)</script>",
  "> <img src=x onerror=alert(4)>",
  "`<script>alert(5)</script>`",
  "```\n<script>alert(6)</script>\n```",
  "**<img src=x onerror=alert(7)>**",
  "javascript:alert(8)",
  "https://example.com/<script>alert(9)</script>",
  "| <script>alert(10)</script> | [x](javascript:alert(11)) |\n| --- | --- |\n| <img src=x onerror=alert(12)> | ![x](javascript:alert(13)) |",
  "![x](https://example.com/x.png)",
  "<details open ontoggle=alert(14)>",
  "## <a id=\"app\" name=\"location\">clobber</a>",
].join("\n\n");
// The same hostile text as a note and as a page (with front matter in front of it).
const out = html(hostile) + pageHtmlOf(`---\ntitle: <script>alert(15)</script>\nonclick: alert(16)\n---\n\n${hostile}\n\n[ok](other.md) ![ok](shot.png) [gone](javascript.md)`);
if (process.argv.includes("-v")) console.log(`\n${out}\n`);

// Every tag React wrote. If note text had become markup, its tag or attribute would be here.
const tags = [...out.matchAll(/<([a-z0-9]+)((?:\s+[a-zA-Z-]+(?:="[^"]*")?)*)\s*\/?>/g)];
const names = new Set(tags.map((t) => t[1]));
const attrs = tags.flatMap((t) => [...t[2].matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)].map((a) => [a[1].toLowerCase(), a[2] ?? ""]));
const hrefs = attrs.filter(([n]) => n === "href").map(([, v]) => v);

const ALLOWED_TAGS = new Set(["div", "p", "br", "a", "strong", "em", "del", "code", "pre", "ul", "ol", "li", "input", "span", "blockquote", "hr", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tr", "th", "td", "details", "summary", "dl", "dt", "dd", "img"]);
const ALLOWED_ATTRS = new Set(["class", "href", "target", "rel", "type", "checked", "disabled", "title", "aria-label", "start", "id", "src", "alt", "loading"]);
check("hostile note: only the renderer's own tags", [...names].every((n) => ALLOWED_TAGS.has(n)), [...names].join(" "));
check("hostile note: no script, svg, or iframe element", !["script", "svg", "iframe"].some((n) => names.has(n)));
const srcs = attrs.filter(([n]) => n === "src").map(([, v]) => v);
check("hostile note: the only image is the board's own file", srcs.length === 1 && srcs[0] === "/tasks/api/files/docs/shot.png?board=b1", srcs.join(" "));
const ids = attrs.filter(([n]) => n === "id").map(([, v]) => v);
check("hostile note: every id is the renderer's own md-…", ids.length > 0 && ids.every((v) => /^md-[\p{L}\p{N}_-]+$/u.test(v)), ids.join(" "));
check("hostile note: only the renderer's own attributes", attrs.every(([n]) => ALLOWED_ATTRS.has(n)), attrs.map(([n]) => n).join(" "));
check("hostile note: no on* attribute", !attrs.some(([n]) => n.startsWith("on")));
check("hostile note: every href is http, https, mailto, or this board's own page route", hrefs.length > 0 && hrefs.every((h) => /^(https?:\/\/|mailto:|\/tasks\/pages\?board=b1&amp;path=)/.test(h)), hrefs.join(" "));
check("hostile note: no javascript: href", !hrefs.some((h) => /^\s*javascript:/i.test(h)));
check("hostile note: the raw HTML shows as text", out.includes("&lt;script&gt;alert(&#x27;xss&#x27;)&lt;/script&gt;") && out.includes("&lt;img src=x onerror="));
const anchors = [...out.matchAll(/<a\s[^>]*>/g)].map((m) => m[0]).filter((a) => !a.includes('href="/tasks/pages?'));
check("every link off the board opens in a new tab with rel=noopener noreferrer", anchors.length > 0 && anchors.every((a) => a.includes('target="_blank"') && a.includes('rel="noopener noreferrer"')), anchors.join(" "));

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
