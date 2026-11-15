import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { roundUpToQuarterHour } from "./format";

describe("roundUpToQuarterHour", () => {
  it("moves a time up to the next quarter hour, when the crons run", () => {
    assert.equal(roundUpToQuarterHour(new Date("2026-11-16T09:07:30Z")).toISOString(), "2026-11-16T09:15:00.000Z");
    assert.equal(roundUpToQuarterHour(new Date("2026-11-16T09:46:00Z")).toISOString(), "2026-11-16T10:00:00.000Z");
  });
  it("leaves a time already on a quarter hour alone", () => {
    assert.equal(roundUpToQuarterHour(new Date("2026-11-16T09:30:00Z")).toISOString(), "2026-11-16T09:30:00.000Z");
  });
});
