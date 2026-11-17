import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays, daysCovered, mondayOf, weekDays } from "../calendar-week";
import { digitsOf, formatPhone, matchKey, smsSegments, toE164 } from "./numbers";
import { callOutcome, formatCallDuration, forwardedLine, laterTextStatus, numberTeammateId, optKeyword } from "./rules";
import { liveCheckDue } from "../live-rules";

describe("phone numbers", () => {
  it("turns numbers as people type them into E.164", () => {
    assert.equal(toE164("(303) 555-0123"), "+13035550123");
    assert.equal(toE164("303.555.0123 x45"), "+13035550123");
    assert.equal(toE164("1-303-555-0123"), "+13035550123");
    assert.equal(toE164("+44 20 7946 0958"), "+442079460958");
    assert.equal(toE164("0044 20 7946 0958"), "+442079460958");
    assert.equal(toE164("020 7946 0958", "44"), "+442079460958");
    assert.equal(toE164("555-0123"), null);
    assert.equal(toE164(""), null);
    assert.equal(toE164(null), null);
  });

  it("matches numbers on their last 10 digits, whatever the punctuation", () => {
    assert.equal(matchKey("+1 (303) 555-0123"), matchKey("303-555-0123"));
    assert.equal(matchKey("303-555-0123 ext. 9"), "3035550123");
    assert.equal(digitsOf("+1 303"), "1303");
  });

  it("shows North American numbers the familiar way", () => {
    assert.equal(formatPhone("+13035550123"), "(303) 555-0123");
    assert.equal(formatPhone("+442079460958"), "+442079460958");
    assert.equal(formatPhone(null), "");
  });

  it("counts SMS segments the way carriers bill them", () => {
    assert.equal(smsSegments(""), 0);
    assert.equal(smsSegments("a".repeat(160)), 1);
    assert.equal(smsSegments("a".repeat(161)), 2);
    assert.equal(smsSegments("€".repeat(80)), 1);
    assert.equal(smsSegments("€".repeat(81)), 2);
    assert.equal(smsSegments("Hi 👋"), 1);
    assert.equal(smsSegments("👋".repeat(71)), 2);
  });
});

describe("calls and texts", () => {
  it("reads a call's outcome from where it ended up", () => {
    assert.equal(callOutcome("completed", "outbound", 42), "Connected");
    assert.equal(callOutcome("completed", "outbound", 0), "No answer");
    assert.equal(callOutcome("completed", "inbound", 30), "Answered");
    assert.equal(callOutcome("no-answer", "inbound", null), "Missed");
    assert.equal(callOutcome("busy", "outbound", null), "Busy");
    assert.equal(callOutcome("ringing", "outbound", null), null);
  });

  it("says how long a call was", () => {
    assert.equal(formatCallDuration(45), "45 sec");
    assert.equal(formatCallDuration(185), "3 min");
    assert.equal(formatCallDuration(3720), "1 hr 2 min");
    assert.equal(formatCallDuration(null), null);
  });

  it("knows the opt-out and opt-in keywords, and nothing else", () => {
    assert.equal(optKeyword("STOP"), "out");
    assert.equal(optKeyword(" stop. "), "out");
    assert.equal(optKeyword("Unsubscribe"), "out");
    assert.equal(optKeyword("START"), "in");
    assert.equal(optKeyword("Please stop calling me"), null);
    assert.equal(optKeyword("Sounds good"), null);
  });

  it("only moves a text's status forward", () => {
    assert.equal(laterTextStatus("queued", "sent"), true);
    assert.equal(laterTextStatus("delivered", "sent"), false);
    assert.equal(laterTextStatus("sent", "undelivered"), true);
  });
});

describe("calendar weeks", () => {
  it("starts weeks on Monday", () => {
    assert.equal(mondayOf("2026-11-16"), "2026-11-16");
    assert.equal(mondayOf("2026-11-22"), "2026-11-16");
    assert.equal(mondayOf("2026-11-23"), "2026-11-23");
    assert.deepEqual(weekDays("2026-12-28").slice(-2), ["2027-01-02", "2027-01-03"]);
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  });

  it("shows a multi-day event on every day it covers, including ones that began before the week", () => {
    const week = weekDays("2026-11-16");
    const utc = (iso: string) => iso.slice(0, 10);
    // All-day, Wed to Fri (end date is exclusive).
    assert.deepEqual(daysCovered({ start: "2026-11-18T00:00:00Z", end: "2026-11-21T00:00:00Z", allDay: true }, week, utc), ["2026-11-18", "2026-11-19", "2026-11-20"]);
    // Began the week before, ends Tuesday.
    assert.deepEqual(daysCovered({ start: "2026-11-13T09:00:00Z", end: "2026-11-17T17:00:00Z", allDay: false }, week, utc), ["2026-11-16", "2026-11-17"]);
    // Ending at midnight doesn't spill into the next day.
    assert.deepEqual(daysCovered({ start: "2026-11-16T22:00:00Z", end: "2026-11-17T00:00:00Z", allDay: false }, week, utc), ["2026-11-16"]);
    // No end: just its start day.
    assert.deepEqual(daysCovered({ start: "2026-11-19T15:00:00Z", end: null, allDay: false }, week, utc), ["2026-11-19"]);
  });
});

describe("who looks after a number", () => {
  const team = [
    { id: "sam", phone: "+13035550123", active: true },
    { id: "ana", phone: null, active: true },
    { id: "old", phone: "+13035550199", active: false },
  ];

  it("gives calls to the teammate whose cell the number forwards to, however it was typed", () => {
    assert.equal(numberTeammateId({ forwardTo: "+13035550123", forwardUserId: "ana" }, team), "sam");
    assert.equal(numberTeammateId({ forwardTo: "(303) 555-0123", forwardUserId: null }, team), "sam");
  });

  it("falls back to the teammate picked on the number", () => {
    assert.equal(numberTeammateId({ forwardTo: "+13035550111", forwardUserId: "ana" }, team), "ana");
    assert.equal(numberTeammateId({ forwardTo: null, forwardUserId: "ana" }, team), "ana");
  });

  it("skips deactivated teammates", () => {
    assert.equal(numberTeammateId({ forwardTo: "+13035550199", forwardUserId: null }, team), null);
    assert.equal(numberTeammateId({ forwardTo: null, forwardUserId: "old" }, team), null);
  });

  it("says where a call was forwarded", () => {
    const number = { label: "Main line" };
    assert.equal(forwardedLine("+13035550123", { name: "Sam", phone: "+13035550123" }, number), "Forwarded to Sam's cell, (303) 555-0123.");
    assert.equal(forwardedLine("+13035550123", { name: "Ana", phone: null }, number), "Forwarded to (303) 555-0123, for Ana.");
    assert.equal(forwardedLine("+13035550123", null, number), "Forwarded to (303) 555-0123.");
    assert.equal(forwardedLine(null, null, number), "Main line has no forwarding number, so no one picked up.");
  });
});

describe("live updates", () => {
  const base = { now: 100_000, lastCheck: 60_000, lastActive: 90_000, visible: true, pollSeconds: 30, idleMinutes: 10 };
  it("asks once per interval while the tab is visible and in use", () => {
    assert.equal(liveCheckDue(base), true);
    assert.equal(liveCheckDue({ ...base, lastCheck: 80_000 }), false);
  });
  it("stops when the tab is hidden, idle or the check is off", () => {
    assert.equal(liveCheckDue({ ...base, visible: false }), false);
    assert.equal(liveCheckDue({ ...base, now: 90_000 + 10 * 60_000 + 1 }), false);
    assert.equal(liveCheckDue({ ...base, pollSeconds: 0 }), false);
  });
});
