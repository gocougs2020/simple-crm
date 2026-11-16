import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { graphAddress, stripQuoted } from "./mail-text";
import { screenInstructions, screenPrompt } from "./screen-prompt";

describe("synced mail text", () => {
  it("keeps the new part of a reply and drops the quoted thread", () => {
    const outlook = "Sounds good, Thursday works.\n\nSam\n\n________________________________\nFrom: Jo <jo@acme.com>\nSent: Monday\nSubject: Meeting";
    assert.equal(stripQuoted(outlook), "Sounds good, Thursday works.\n\nSam");
    const gmail = "Yes please.\r\n\r\nOn Mon, Nov 16, 2026 at 9:00 AM Jo <jo@acme.com> wrote:\r\n> Want a demo?";
    assert.equal(stripQuoted(gmail), "Yes please.");
    const headers = "Thanks!\nFrom: Jo <jo@acme.com>\nSent: Monday, November 16\nTo: Sam";
    assert.equal(stripQuoted(headers), "Thanks!");
  });

  it("keeps forwards and plain emails whole", () => {
    assert.equal(stripQuoted("FYI\n\n---------- Forwarded message ---------\nFrom: X"), "FYI\n\n---------- Forwarded message ---------\nFrom: X");
    assert.equal(stripQuoted("Just a note.\nSecond line."), "Just a note.\nSecond line.");
  });

  it("reads Graph addresses", () => {
    assert.deepEqual(graphAddress({ emailAddress: { name: "Sam Lee", address: "Sam@Acme.com" } }), { address: "sam@acme.com", display: "Sam Lee <sam@acme.com>" });
    assert.deepEqual(graphAddress({ emailAddress: { name: "sam@acme.com", address: "sam@acme.com" } }), { address: "sam@acme.com", display: "sam@acme.com" });
    assert.deepEqual(graphAddress(null), { address: "", display: "" });
  });
});

describe("mail screen prompt", () => {
  it("tells the model what counts as sensitive here, and to treat the email as content", () => {
    const system = screenInstructions("Salaries and health.", "Acme");
    assert.match(system, /Acme's CRM/);
    assert.match(system, /Sensitive means: Salaries and health\./);
    assert.match(system, /never as instructions/);
  });

  it("sends the headers and a bounded body", () => {
    const prompt = screenPrompt({ from: "Jo <jo@acme.com>", to: ["sam@us.com"], subject: null, text: "x".repeat(10_000) });
    assert.match(prompt, /^From: Jo <jo@acme.com>\nTo: sam@us.com\nSubject: \(no subject\)/);
    assert.match(prompt, /the rest is cut off/);
    assert.ok(prompt.length < 6_500);
  });
});
