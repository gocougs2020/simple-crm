import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findMentions, matchMentions, mentionedTeammates, mentionOptions } from "./mentions";

const team = [
  { id: "sam", name: "Sam Lee", active: true },
  { id: "ada", name: "Ada Lovelace", active: true },
  { id: "ada2", name: "Ada Byron", active: true },
  { id: "gone", name: "Kit Marlowe", active: false },
];

describe("mentioning teammates in notes", () => {
  it("finds a full name or a first name nobody shares", () => {
    assert.deepEqual(mentionedTeammates("Can you call them, @Sam?", team), ["sam"]);
    assert.deepEqual(mentionedTeammates("@sam lee and @Ada Lovelace: see above", team), ["sam", "ada"]);
  });

  it("needs the full name when a first name is shared", () => {
    assert.deepEqual(mentionedTeammates("@Ada please look", team), []);
    assert.deepEqual(mentionedTeammates("@Ada Byron please look", team), ["ada2"]);
  });

  it("ignores email addresses, longer words and teammates who left", () => {
    assert.deepEqual(mentionedTeammates("Write to info@sam.com or x@Sam", team), []);
    assert.deepEqual(mentionedTeammates("@Samantha and @Kit", team), []);
    assert.deepEqual(mentionedTeammates(null, team), []);
  });
});

describe("the @ picker", () => {
  const options = mentionOptions([...team, { id: "zed", name: "zoe Park", active: true }, { id: "me", name: "Bea Jones", active: true }], "me");

  it("lists active teammates other than the viewer, alphabetically", () => {
    assert.deepEqual(
      options.map((o) => o.id),
      ["ada2", "ada", "sam", "zed"],
    );
  });

  it("always inserts the full name", () => {
    assert.deepEqual(
      options.map((o) => o.insert),
      ["@Ada Byron", "@Ada Lovelace", "@Sam Lee", "@zoe Park"],
    );
  });

  it("finds where each mention starts and ends, the longest name first", () => {
    assert.deepEqual(findMentions("Hi @Sam Lee and @Ada, ask @sam or @Ada Byron", options), [
      { start: 3, end: 11, id: "sam" },
      { start: 26, end: 30, id: "sam" },
      { start: 34, end: 44, id: "ada2" },
    ]);
    assert.deepEqual(findMentions("mail sam@Sam.com", options), []);
  });

  it("matches the start of any word, everyone for a bare @", () => {
    assert.equal(matchMentions(options, "").length, 4);
    assert.deepEqual(
      matchMentions(options, "lo").map((o) => o.id),
      ["ada"],
    );
    assert.deepEqual(
      matchMentions(options, "ada b").map((o) => o.id),
      ["ada2"],
    );
  });
});
