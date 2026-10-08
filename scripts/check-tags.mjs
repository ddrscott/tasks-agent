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
const { splitTitleTags, addCard, cleanTag, matchesTags, MAX_TAGS_PER_CARD } = await import(pathToFileURL(outfile).href);
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
