import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planRecipients } from "./recipients";

describe("planRecipients", () => {
  it("keeps each address once, and on To when it's on both lines", () => {
    const plan = planRecipients({
      to: [
        { personId: "a", email: "ana@acme.com" },
        { personId: "b", email: "Ben@acme.com" },
      ],
      cc: [
        { personId: "b", email: "ben@acme.com" },
        { personId: "c", email: "cy@acme.com" },
        { personId: null, email: "CY@acme.com" },
        { personId: null, email: "legal@acme.com" },
      ],
    });
    assert.deepEqual(plan.to, ["ana@acme.com", "Ben@acme.com"]);
    assert.deepEqual(plan.cc, ["cy@acme.com", "legal@acme.com"]);
    assert.equal(plan.total, 4);
    assert.deepEqual(plan.otherPersonIds, ["b", "c"]);
  });

  it("counts To and Cc together", () => {
    const entries = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ personId: `${prefix}${i}`, email: `${prefix}${i}@acme.com` }));
    assert.equal(planRecipients({ to: entries(6, "t"), cc: entries(5, "c") }).total, 11);
  });

  it("two people sharing an address are one recipient, on one timeline", () => {
    const plan = planRecipients({ to: [{ personId: "a", email: "team@acme.com" }], cc: [{ personId: "b", email: "team@acme.com" }] });
    assert.equal(plan.total, 1);
    assert.deepEqual(plan.otherPersonIds, []);
  });
});
