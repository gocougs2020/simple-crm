import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { standingPreview } from "@/components/agent/agent-message";

describe("confirm card for skills and scheduled jobs", () => {
  it("shows every value a job would be saved with, including its day and date", () => {
    assert.deepEqual(standingPreview("create_scheduled_job", { name: "Review", request: "List stale prospects.", every: "week", weekday: 1, time: "08:00" }), [
      ["Name", "Review"],
      ["What it does", "List stale prospects."],
      ["How often", "week"],
      ["Day of the week", "Monday"],
      ["Time", "08:00"],
    ]);
    assert.deepEqual(standingPreview("create_scheduled_job", { name: "Once", request: "x", every: "once", onDate: "2026-12-01", time: "09:00" }).slice(3), [["Date", "2026-12-01"], ["Time", "09:00"]]);
    assert.deepEqual(standingPreview("update_scheduled_job", { id: "j1", every: "month", monthDay: 15 }), [["How often", "month"], ["Day of the month", "15"]]);
  });

  it("shows a change of only the time, or only on and off", () => {
    assert.deepEqual(standingPreview("update_scheduled_job", { id: "j1", time: "03:15" }), [["Time", "03:15"]]);
    assert.deepEqual(standingPreview("update_scheduled_job", { id: "j1", enabled: false }), [["Status", "Paused"]]);
    assert.deepEqual(standingPreview("update_skill", { id: "s1", enabled: true, mode: "always" }), [["Used", "Always on"], ["Status", "On"]]);
  });

  it("stays out of other tools' cards", () => {
    assert.deepEqual(standingPreview("archive_client", { id: "c1", name: "Acme" }), []);
    assert.deepEqual(standingPreview("merge_people", { id: "p1", time: "08:00" }), []);
  });
});
