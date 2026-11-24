import assert from "node:assert/strict";
import { test } from "node:test";
import { inviteState } from "./invite-state";

const now = new Date("2026-11-24T12:00:00Z");

test("a teammate who has joined has no invite state", () => {
  assert.equal(inviteState(true, new Date("2026-11-30T00:00:00Z"), now), null);
  assert.equal(inviteState(true, null, now), null);
});

test("someone added without an invite (an import) reads as not invited, not as invite sent", () => {
  assert.deepEqual(inviteState(false, null, now), { state: "none", expiresAt: null });
});

test("a link that still works is sent; one past its expiry is expired", () => {
  const later = new Date("2026-11-30T00:00:00Z");
  const earlier = new Date("2026-11-20T00:00:00Z");
  assert.deepEqual(inviteState(false, later, now), { state: "sent", expiresAt: later });
  assert.deepEqual(inviteState(false, earlier, now), { state: "expired", expiresAt: earlier });
  assert.equal(inviteState(false, now, now)?.state, "expired");
});
