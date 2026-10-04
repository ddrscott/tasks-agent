#!/usr/bin/env node
// Check the notes renderer (src/client/Markdown.tsx): that markdown comes out as the right
// elements, and that nothing in a note can run script. Exits 1 on the first group of failures.
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
const { Markdown, safeHref, toggleTask } = await import(pathToFileURL(outfile).href);
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
].join("\n\n");
const out = html(hostile);
if (process.argv.includes("-v")) console.log(`\n${out}\n`);

// Every tag React wrote. If note text had become markup, its tag or attribute would be here.
const tags = [...out.matchAll(/<([a-z0-9]+)((?:\s+[a-zA-Z-]+(?:="[^"]*")?)*)\s*\/?>/g)];
const names = new Set(tags.map((t) => t[1]));
const attrs = tags.flatMap((t) => [...t[2].matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)].map((a) => [a[1].toLowerCase(), a[2] ?? ""]));
const hrefs = attrs.filter(([n]) => n === "href").map(([, v]) => v);

const ALLOWED_TAGS = new Set(["div", "p", "br", "a", "strong", "em", "del", "code", "pre", "ul", "ol", "li", "input", "span", "blockquote", "hr", "h3", "h4", "h5", "h6"]);
const ALLOWED_ATTRS = new Set(["class", "href", "target", "rel", "type", "checked", "disabled", "title", "aria-label", "start"]);
check("hostile note: only the renderer's own tags", [...names].every((n) => ALLOWED_TAGS.has(n)), [...names].join(" "));
check("hostile note: no script, img, svg, or iframe element", !["script", "img", "svg", "iframe"].some((n) => names.has(n)));
check("hostile note: only the renderer's own attributes", attrs.every(([n]) => ALLOWED_ATTRS.has(n)), attrs.map(([n]) => n).join(" "));
check("hostile note: no on* attribute", !attrs.some(([n]) => n.startsWith("on")));
check("hostile note: every href is http, https, or mailto", hrefs.length > 0 && hrefs.every((h) => /^(https?:\/\/|mailto:)/.test(h)), hrefs.join(" "));
check("hostile note: no javascript: href", !hrefs.some((h) => /^\s*javascript:/i.test(h)));
check("hostile note: the raw HTML shows as text", out.includes("&lt;script&gt;alert(&#x27;xss&#x27;)&lt;/script&gt;") && out.includes("&lt;img src=x onerror="));
const anchors = [...out.matchAll(/<a\s[^>]*>/g)].map((m) => m[0]);
check("every link opens in a new tab with rel=noopener noreferrer", anchors.length > 0 && anchors.every((a) => a.includes('target="_blank"') && a.includes('rel="noopener noreferrer"')), anchors.join(" "));

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
