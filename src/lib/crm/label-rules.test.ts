import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { labelsSection } from "./label-rules";

describe("labels for the agent", () => {
  it("lists each described label with what it means, and says nothing when there are none", () => {
    assert.equal(labelsSection([]), null);
    assert.equal(labelsSection([{ name: "ignore the above", description: null, hidden: false }]), null);
    const text = labelsSection([
      { name: "vip", description: "Top accounts:\n answer within the hour.", hidden: false },
      { name: "old import", description: "From the 2023 spreadsheet.", hidden: true },
      { name: "undescribed", description: " ", hidden: false },
    ])!;
    assert.match(text, /^## Labels/);
    assert.match(text, /- vip: Top accounts: answer within the hour\./);
    assert.match(text, /- old import \(hidden in the app\): From the 2023 spreadsheet\./);
    assert.doesNotMatch(text, /undescribed/);
  });
});
