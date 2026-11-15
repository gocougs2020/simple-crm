import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addressProblem, deliveryDetail, eventStatus, eventTag, movesForward, percent, statusFromLastEvent } from "./delivery-status";

describe("delivery status", () => {
  it("only moves forward, so late or repeated reports can't undo a later one", () => {
    assert.equal(movesForward(null, "sent"), true);
    assert.equal(movesForward("delivered", "sent"), false);
    assert.equal(movesForward("delivered", "delivered"), true);
    assert.equal(movesForward("delivered", "bounced"), true);
    assert.equal(movesForward("complained", "delivered"), false);
  });
  it("treats opens and clicks as delivered", () => {
    assert.equal(eventStatus["email.opened"], "delivered");
    assert.equal(eventStatus["email.clicked"], "delivered");
    assert.equal(statusFromLastEvent("clicked"), "delivered");
    assert.equal(statusFromLastEvent("queued"), null);
    assert.equal(statusFromLastEvent("canceled"), "failed");
  });
  it("protects the address only for a permanent bounce or a complaint", () => {
    assert.equal(addressProblem("bounced", { bounce: { type: "Permanent" } }), "bounced");
    assert.equal(addressProblem("bounced", { bounce: { type: "Transient" } }), null);
    assert.equal(addressProblem("complained", {}), "complained");
    assert.equal(addressProblem("delivered", {}), null);
  });
  it("explains what went wrong in Resend's words", () => {
    assert.equal(deliveryDetail("bounced", { bounce: { type: "Permanent", subType: "General", message: "No such user" } }), "Permanent: General: No such user");
    assert.equal(deliveryDetail("failed", { failed: { reason: "Domain not verified" } }), "Domain not verified");
    assert.equal(deliveryDetail("delivered", {}), null);
  });
  it("reads tags in either shape Resend sends", () => {
    assert.equal(eventTag({ type: "campaign" }, "type"), "campaign");
    assert.equal(eventTag([{ name: "type", value: "direct" }], "type"), "direct");
  });
  it("rounds rates down, so one bounce never reads 100%", () => {
    assert.equal(percent(999, 1000), 99);
    assert.equal(percent(0, 0), 0);
  });
});
