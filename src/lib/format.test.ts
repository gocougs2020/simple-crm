import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { archivedToast, roundUpToQuarterHour } from "./format";

describe("roundUpToQuarterHour", () => {
  it("moves a time up to the next quarter hour, when the crons run", () => {
    assert.equal(roundUpToQuarterHour(new Date("2026-11-16T09:07:30Z")).toISOString(), "2026-11-16T09:15:00.000Z");
    assert.equal(roundUpToQuarterHour(new Date("2026-11-16T09:46:00Z")).toISOString(), "2026-11-16T10:00:00.000Z");
  });
  it("leaves a time already on a quarter hour alone", () => {
    assert.equal(roundUpToQuarterHour(new Date("2026-11-16T09:30:00Z")).toISOString(), "2026-11-16T09:30:00.000Z");
  });
});

describe("archivedToast", () => {
  it("says what open work went with the archived records", () => {
    assert.equal(archivedToast("Client", 0), "Client archived");
    assert.equal(archivedToast("Client", 1), "Client archived, with 1 open task or meeting");
    assert.equal(archivedToast("3 people", 4), "3 people archived, with 4 open tasks and meetings");
  });
});
