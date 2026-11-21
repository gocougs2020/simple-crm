import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eventRow, inChunks } from "./event-rows";

describe("history rows", () => {
  it("writes an entry the same way whether it's one or many", () => {
    const one = { entityType: "person" as const, entityId: "p1", action: "archived", userId: "u1" };
    assert.deepEqual(eventRow(one), { ...one, data: {} });
    assert.deepEqual(eventRow({ ...one, data: { changes: [] }, apiKeyId: "k1" }), { ...one, data: { changes: [] }, apiKeyId: "k1" });
  });

  it("splits a big bulk change into inserts that fit, keeping every row in order", () => {
    const rows = Array.from({ length: 2500 }, (_, i) => i);
    const chunks = inChunks(rows);
    assert.deepEqual(chunks.map((c) => c.length), [1000, 1000, 500]);
    assert.deepEqual(chunks.flat(), rows);
    assert.deepEqual(inChunks([]), []);
  });
});
