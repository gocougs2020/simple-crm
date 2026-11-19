import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mentionedTeammates } from "./mentions";

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
