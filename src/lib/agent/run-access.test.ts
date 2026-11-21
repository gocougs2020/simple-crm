import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAccess } from "./run-access";

describe("background run access", () => {
  it("lets a running task act for an active teammate", () => {
    assert.deepEqual(runAccess({ status: "running", deactivatedAt: null }), { ok: true });
  });

  it("refuses a run that isn't running, or isn't found for this teammate", () => {
    for (const status of ["queued", "done", "failed", "cancelled"]) {
      const r = runAccess({ status, deactivatedAt: null });
      assert.equal(r.ok, false);
      assert.match(!r.ok ? r.message : "", /has ended/);
    }
    assert.equal(runAccess(undefined).ok, false);
  });

  it("refuses a deactivated teammate, even mid-run", () => {
    const r = runAccess({ status: "running", deactivatedAt: new Date() });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.message : "", /deactivated/);
  });
});
