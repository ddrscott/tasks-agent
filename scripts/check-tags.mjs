#!/usr/bin/env node
// Check tags typed into a title (src/shared.ts: splitTitleTags): trailing #tags come off the
// title and onto the card, and a title meant literally (C#, #123, a # mid-word, a tag in the
// middle) is left exactly as typed. Exits 1 on a failure.
//
//   npm run check:tags

import { build } from "esbuild";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;
const dir = join(root, "node_modules", ".cache", "check-tags");
const outfile = join(dir, `shared-${process.pid}.mjs`);
await build({ entryPoints: [join(root, "src/shared.ts")], outfile, bundle: true, format: "esm", platform: "node", logLevel: "error" });
const { splitTitleTags, addCard, cleanTag, matchesTags, matchesText, matchesWhere, textTerms, filterQueryFrom, filterQueryInto, MAX_TAGS_PER_CARD } = await import(pathToFileURL(outfile).href);
rmSync(dir, { recursive: true, force: true });

let failed = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(ok ? `ok   ${name}` : `FAIL ${name}\n     wanted ${JSON.stringify(want)}\n     got    ${JSON.stringify(got)}`);
}
const split = (text, title, tags, have) => check(JSON.stringify(text), splitTitleTags(text, have), { title, tags });
const literal = (text) => split(text, text, []);

console.log("# the tag filter (matchesTags) keeps a card or takes it off the board");
const both = { tags: ["shop-api", "agent"] }, one = { tags: ["agent"] }, none = {};
check("no tags picked shows every card", [both, none].map((c) => matchesTags(c, { tags: [], all: true })), [true, true]);
check("any: one picked tag is enough", [both, one, none].map((c) => matchesTags(c, { tags: ["shop-api", "agent"], all: false })), [true, true, false]);
check("all: every picked tag has to be there", [both, one, none].map((c) => matchesTags(c, { tags: ["shop-api", "agent"], all: true })), [true, false, false]);

console.log("# the filter by person (matchesWhere): mine, a named person, the unassigned, and tags on top");
const jeff = { assignee: "jeff@example.com", tags: ["agent"] }, dana = { assignee: "dana@example.com" }, free = { tags: ["agent"] };
const w = (who, tags = [], text = "") => ({ who, tags, all: false, text });
const seen = (where, me) => [jeff, dana, free].map((c) => matchesWhere(c, where, me));
check("nobody picked shows every card", seen(w([]), "jeff@example.com"), [true, true, true]);
check("mine is the cards assigned to whoever is looking", seen(w(["me"]), "jeff@example.com"), [true, false, false]);
check("mine for someone else", seen(w(["me"]), "dana@example.com"), [false, true, false]);
check("mine with nobody signed in matches nothing", seen(w(["me"]), null), [false, false, false]);
check("a named person", seen(w(["dana@example.com"]), "jeff@example.com"), [false, true, false]);
check("unassigned", seen(w(["none"]), "jeff@example.com"), [false, false, true]);
check("two people: either one", seen(w(["me", "none"]), "jeff@example.com"), [true, false, true]);
check("person and tag narrow together", seen(w(["me", "dana@example.com"], ["agent"]), "jeff@example.com"), [true, false, false]);

console.log("# the filter's text (matchesText): words, quoted phrases, and a minus to leave cards out");
const inv = { title: "Pay the Q3 invoice", notes: "Send to accounting.\nDraft is on hold until Friday", tags: ["shop-api"] };
const cafe = { title: "Café menu redesign", notes: "", assignee: "dana@example.com", attachments: [{ name: "invoice-template.pdf" }] };
const bare = { title: "Hold the door", notes: "" };
const txt = (text) => [inv, cafe, bare].map((c) => matchesText(c, text));
check("no text shows every card", txt(""), [true, true, true]);
check("a word in a title, whatever its case", txt("PAY"), [true, false, false]);
check("a word in the notes", txt("accounting"), [true, false, false]);
check("the start of a word is enough", txt("invo"), [true, true, false]);
check("the middle of a word isn't", txt("voice"), [false, false, false]);
check("every word has to be there, in any order", txt("invoice pay"), [true, false, false]);
check("a quoted phrase is words side by side", txt('"on hold"'), [true, false, false]);
check("the same words apart aren't the phrase", txt('"hold on"'), [false, false, false]);
check("a phrase reaches across punctuation and line ends", txt('"accounting draft"'), [true, false, false]);
check("an open quote is read to the end", txt('"hold the'), [false, false, true]);
check("a minus leaves cards out", txt("hold -door"), [true, false, false]);
check("a minus on a phrase", txt('-"on hold"'), [false, true, true]);
check("only a minus still filters", txt("-invoice"), [false, false, true]);
check("accents don't count", txt("cafe"), [false, true, false]);
check("a tag is read, with or without its #", txt("#shop-api"), [true, false, false]);
check("an assignee is read", txt("dana"), [false, true, false]);
check("a file's name is read", txt("template"), [false, true, false]);
check("punctuation alone is no filter", txt('- "" !!'), [true, true, true]);
check("text narrows with a person and a tag", [inv, cafe, bare].map((c) => matchesWhere(c, w([], ["shop-api"], "invoice"), null)), [true, false, false]);
check("how the text is read", textTerms('pay -draft "On Hold" shop-api'), [{ words: " pay", not: false }, { words: " draft", not: true }, { words: " on hold", not: false }, { words: " shop", not: false }, { words: " api", not: false }]);

console.log("# the filters in the address (filterQueryFrom, filterQueryInto)");
const off = { where: { tags: [], all: false, who: [], text: "" }, fade: null };
check("no query is no filter", filterQueryFrom(""), off);
check("tags, match, and fade are read", filterQueryFrom("?tags=agent,shop-api&match=all&fade=bug"), { where: { tags: ["agent", "shop-api"], all: true, who: [], text: "" }, fade: "bug" });
check("an encoded comma reads the same", filterQueryFrom("?tags=agent%2Cshop-api").where.tags, ["agent", "shop-api"]);
check("what isn't a tag is dropped", filterQueryFrom("?tags=%23Agent,,agent,%3Cb%3E!&match=every&fade=%20"), { where: { tags: ["agent", "b"], all: false, who: [], text: "" }, fade: null });
check("written so a person can read it", filterQueryInto("", { where: { tags: ["agent", "shop-api"], all: true, who: [], text: "" }, fade: "bug" }), "?tags=agent,shop-api&match=all&fade=bug");
check("other parameters stay", filterQueryInto("?board=u_1&tags=old", { where: { tags: ["agent"], all: false, who: [], text: "" }, fade: null }), "?board=u_1&tags=agent");
check("clearing leaves a bare address", filterQueryInto("?who=me&tags=agent&match=all&fade=bug", off), "");
check("there and back", filterQueryFrom(filterQueryInto("?board=u_1", { where: { tags: ["été", "v2"], all: true, who: ["me", "dana@example.com"], text: "" }, fade: "shop_api" })), { where: { tags: ["été", "v2"], all: true, who: ["me", "dana@example.com"], text: "" }, fade: "shop_api" });
check("who is read: me, none, and emails, lower-cased", filterQueryFrom("?who=Me,Dana%40Example.com,none").where.who, ["me", "dana@example.com", "none"]);
check("what isn't a person is dropped", filterQueryFrom("?who=everyone,,me,me,%3Cb%3E,a@b").where.who, ["me"]);
check("text is read, with its spaces tidied", filterQueryFrom("?q=%20pay%20%20-draft+%22on+hold%22").where.text, 'pay -draft "on hold"');
check("text is written beside the rest", filterQueryInto("?board=u_1", { where: { tags: ["agent"], all: false, who: ["me"], text: 'pay -draft "on hold"' }, fade: null }), "?board=u_1&who=me&tags=agent&q=pay+-draft+%22on+hold%22");
check("text there and back", filterQueryFrom(filterQueryInto("", { where: { tags: [], all: false, who: [], text: "a&b=c #x 100%" }, fade: null })).where.text, "a&b=c #x 100%");
check("who is written so a person can read it", filterQueryInto("?board=u_1", { where: { tags: ["agent"], all: false, who: ["me", "dana@example.com"], text: "" }, fade: null }), "?board=u_1&who=me,dana@example.com&tags=agent");

console.log("# trailing tags come off the title");
split("Write a haiku #agent", "Write a haiku", ["agent"]);
split("Fix login #agent #shop-api", "Fix login", ["agent", "shop-api"]);
split("Fix login   #agent  ", "Fix login", ["agent"]);
split("Fix login\t#agent", "Fix login", ["agent"]);
split("Ship it #Agent", "Ship it", ["agent"]);
split("Ship it #agent #AGENT #agent", "Ship it", ["agent"]);
split("Ship it #shop_api #v2", "Ship it", ["shop_api", "v2"]);
split("Écrire un haïku #été", "Écrire un haïku", ["été"]);
split("Fix #123 #agent", "Fix #123", ["agent"]);
split("Learn C# #agent", "Learn C#", ["agent"]);
split("Review #agent setup #agent", "Review #agent setup", ["agent"]);

console.log("# a title meant literally stays as typed");
literal("Write a haiku");
literal("Fix #123");
literal("Fix issue #123 #456");
literal("Learn C#");
literal("Learn C# and F#");
literal("Rename foo#bar");
literal("Tag a card #agent first");
literal("Ask in #general.");
literal("Is this a #tag?");
literal("Use #a.b");
literal("Trailing hash #");
literal("Double ##agent");
literal("#agent");
literal("#agent #shop-api");
literal("  #agent");
literal("");
literal("   ");
literal(`Too long #${"a".repeat(33)}`);
literal("Decide #needs-ceo");

console.log("# stops at the first word that isn't a tag");
split("Fix #agent now #later", "Fix #agent now", ["later"]);
split("Bump #123 #agent #456", "Bump #123 #agent #456", []);
split("Decide #needs-ceo #agent", "Decide #needs-ceo", ["agent"]);

console.log("# tags the card already has (the New card dialog's Tags field)");
split("Fix login #agent", "Fix login", ["client", "agent"], ["client"]);
split("Fix login #client", "Fix login", ["client"], ["client"]);
split("Fix login", "Fix login", ["client"], ["client"]);

console.log("# the tag cap");
const many = Array.from({ length: 12 }, (_, i) => `t${i + 1}`);
check("MAX_TAGS_PER_CARD", MAX_TAGS_PER_CARD, 10);
split(`Big one ${many.map((t) => `#${t}`).join(" ")}`, "Big one #t1 #t2", many.slice(2));
const full = many.slice(0, 10);
split("Full already #extra", "Full already #extra", full, full);
split("Full already #t3", "Full already", full, full);
split("Nine there #x #y", "Nine there #x", [...full.slice(0, 9), "y"], full.slice(0, 9));

console.log("# sealed text passes through");
const jwe = "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIiwia2lkIjoiazEifQ..AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA";
literal(jwe);

console.log("# every tag it returns is already clean, and addCard takes the result as is");
for (const text of ["Write a haiku #Agent #Shop-API", `Big one ${many.map((t) => `#${t}`).join(" ")}`]) {
  const r = splitTitleTags(text);
  check(`clean: ${text.slice(0, 30)}`, r.tags.map(cleanTag), r.tags);
}
const board = { theme: "auto", lanes: [{ id: "todo", name: "To do" }, { id: "done", name: "Done" }], cards: [] };
const added = addCard(board, { ...splitTitleTags("Write a haiku #agent"), laneId: "todo" }).card;
check("addCard: title", added.title, "Write a haiku");
check("addCard: tags", added.tags, ["agent"]);
const plain = addCard(board, { ...splitTitleTags("Learn C#"), laneId: "todo" }).card;
check("addCard: literal title", plain.title, "Learn C#");
check("addCard: no tags field", "tags" in plain, false);
// What an agent sends over MCP goes straight to addCard and is never parsed.
check("addCard alone leaves #agent in the title", addCard(board, { title: "Write a haiku #agent", laneId: "todo" }).card.title, "Write a haiku #agent");

console.log(failed ? `\n${failed} failed` : "\nall ok");
process.exit(failed ? 1 : 0);
