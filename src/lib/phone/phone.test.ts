import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays, mondayOf, weekDays } from "../calendar-week";
import { digitsOf, formatPhone, matchKey, smsSegments, toE164 } from "./numbers";
import { callOutcome, formatCallDuration, laterTextStatus, optKeyword } from "./rules";

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
});
