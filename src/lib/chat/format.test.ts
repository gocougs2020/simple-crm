import assert from "node:assert/strict";
import { test } from "node:test";
import { chatSegments, mentionQuery } from "./format";

const team = [
  { id: "1", name: "Sam Lee", active: true },
  { id: "2", name: "Sam Ortiz", active: true },
  { id: "3", name: "Priya Shah", active: true },
  { id: "4", name: "Gone Person", active: false },
];

test("full names and unshared first names are mentions", () => {
  const s = chatSegments("Thanks @Priya and @Sam Lee!", team);
  assert.deepEqual(
    s.filter((x) => x.kind === "mention").map((x) => (x.kind === "mention" ? [x.text, x.userId] : null)),
    [
      ["@Priya", "3"],
      ["@Sam Lee", "1"],
    ],
  );
  assert.equal(s.map((x) => x.text).join(""), "Thanks @Priya and @Sam Lee!");
});

test("a first name two teammates share isn't a mention on its own", () => {
  assert.ok(chatSegments("hey @Sam", team).every((x) => x.kind === "text"));
});

test("email addresses and deactivated teammates aren't mentions", () => {
  assert.ok(chatSegments("mail priya@Priya.com or @Gone Person", team).every((x) => x.kind === "text"));
});

test("links are picked out without trailing punctuation", () => {
  const s = chatSegments("See https://example.com/a?b=1. Then call.", team);
  const link = s.find((x) => x.kind === "link");
  assert.equal(link?.text, "https://example.com/a?b=1");
  assert.equal(s.map((x) => x.text).join(""), "See https://example.com/a?b=1. Then call.");
});

test("mentionQuery finds what's being typed after @", () => {
  assert.deepEqual(mentionQuery("hi @pr", 6), { query: "pr", start: 3 });
  assert.deepEqual(mentionQuery("@", 1), { query: "", start: 0 });
  assert.deepEqual(mentionQuery("hi @Sam L", 9), { query: "Sam L", start: 3 });
  assert.equal(mentionQuery("mail a@b", 8), null);
  assert.equal(mentionQuery("hi @Sam Lee ", 12), null);
});
