import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agendaFor, dueForReminder, isMorning, localClock } from "./schedule";

const tz = "America/New_York";
// 2026-03-02 is a Monday. 12:00 UTC is 7:00 AM in New York (EST).
const at = (iso: string) => new Date(iso);

describe("notification schedule", () => {
  it("reads the hour and weekday in the workspace's time zone", () => {
    assert.deepEqual(localClock(at("2026-03-02T12:00:00Z"), tz), { hour: 7, weekday: 1 });
    assert.deepEqual(localClock(at("2026-03-02T03:00:00Z"), tz), { hour: 22, weekday: 7 });
  });

  it("counts the morning from the configured hour, for a few hours", () => {
    assert.equal(isMorning(at("2026-03-02T11:45:00Z"), tz, 7), false);
    assert.equal(isMorning(at("2026-03-02T12:00:00Z"), tz, 7), true);
    assert.equal(isMorning(at("2026-03-02T15:45:00Z"), tz, 7), true);
    assert.equal(isMorning(at("2026-03-02T16:00:00Z"), tz, 7), false);
  });

  it("sends the weekly agenda on Mondays and the daily one on weekdays", () => {
    const monday = at("2026-03-02T12:15:00Z");
    const wednesday = at("2026-03-04T12:15:00Z");
    const saturday = at("2026-03-07T12:15:00Z");
    assert.equal(agendaFor(monday, tz, { weekly: true, daily: true }, 7), "weekly");
    assert.equal(agendaFor(monday, tz, { daily: true }, 7), "daily");
    assert.equal(agendaFor(wednesday, tz, { weekly: true }, 7), null);
    assert.equal(agendaFor(wednesday, tz, { daily: true, weekly: true }, 7), "daily");
    assert.equal(agendaFor(saturday, tz, { daily: true, weekly: true }, 7), null);
    assert.equal(agendaFor(at("2026-03-02T10:00:00Z"), tz, { daily: true }, 7), null);
    assert.equal(agendaFor(monday, tz, undefined, 7), null);
  });

  it("announces a meeting in the quarter hour before it, or just after a missed run", () => {
    const now = at("2026-03-02T15:15:00Z");
    assert.equal(dueForReminder(at("2026-03-02T15:30:00Z"), now), true);
    assert.equal(dueForReminder(at("2026-03-02T15:31:00Z"), now), false);
    assert.equal(dueForReminder(at("2026-03-02T15:12:00Z"), now), true);
    assert.equal(dueForReminder(at("2026-03-02T15:09:00Z"), now), false);
  });
});
