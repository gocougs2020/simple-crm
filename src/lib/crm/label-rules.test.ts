import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { labelsSection } from "./label-rules";

describe("labels for the agent", () => {
  it("lists each label with what it means, and says nothing when there are none", () => {
    assert.equal(labelsSection([]), null);
    const text = labelsSection([
      { name: "vip", description: "Top accounts:\n answer within the hour.", hidden: false },
      { name: "old import", description: null, hidden: true },
    ])!;
    assert.match(text, /^## Labels/);
    assert.match(text, /- vip: Top accounts: answer within the hour\./);
    assert.match(text, /- old import \(hidden in the app\): no description yet/);
  });
});
