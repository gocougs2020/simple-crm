import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { graphAddress, stripQuoted } from "./mail-text";
import { Experimental_DecisionMockModelV4 as MockDecisionModel } from "ai/test";
import { decideSensitive } from "./screen-decide";
import { keepsOut, screenQuestion, screenState } from "./screen-prompt";

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

describe("mail screen", () => {
  it("asks one yes/no question, with what counts as sensitive here", () => {
    const q = screenQuestion("Salaries and health.", "Acme");
    assert.equal(q.type, "boolean");
    assert.match(q.instructions, /Acme's CRM/);
    assert.equal(q.criteria.true, "Sensitive: Salaries and health.");
    assert.match(q.criteria.false, /Ordinary business correspondence/);
  });

  it("passes the email as separate fields, with a bounded body", () => {
    const state = screenState({ from: "Jo <jo@acme.com>", to: ["sam@us.com"], subject: "  ", text: "x".repeat(10_000) }, ["Sam Owner <sam@us.com>"]);
    assert.deepEqual(state.ourTeam, ["Sam Owner <sam@us.com>"]);
    assert.equal(state.from, "Jo <jo@acme.com>");
    assert.deepEqual(state.to, ["sam@us.com"]);
    assert.equal(state.subject, null);
    assert.match(state.body, /the rest is cut off\]$/);
    assert.ok(state.body.length < 6_100);
  });

  it("keeps an email out at or above the threshold", () => {
    assert.equal(keepsOut(0.5, 0.5), true);
    assert.equal(keepsOut(0.49, 0.5), false);
    assert.equal(keepsOut(0.9, 2), false);
    assert.equal(keepsOut(0.6, Number.NaN), true);
  });
});

describe("screening with a decision model", () => {
  const email = { from: "Jo <jo@acme.com>", to: ["sam@us.com"], subject: "Q3 pricing", text: "Can you send the updated quote?" };
  const opts = { sensitive: "Health matters.", workspaceName: "Acme", threshold: 0.6, timeoutMs: 2_000 };
  const model = (probability: number | Error, seen: unknown[] = []) =>
    new MockDecisionModel({
      provider: "typesafe-ai",
      modelId: "jev",
      supportedQuestionTypes: ["boolean"],
      doDecide: async (options) => {
        seen.push(options);
        if (probability instanceof Error) throw probability;
        return { answers: { sensitive: { type: "boolean", probability } }, warnings: [] };
      },
    });

  it("asks one boolean question about the email's fields", async () => {
    const seen: unknown[] = [];
    await decideSensitive(model(0.1, seen), { ...email, ourTeam: ["Sam Owner <sam@us.com>"] }, opts);
    const call = JSON.stringify(seen[0]);
    assert.match(call, /"type":"boolean"/);
    assert.match(call, /Sensitive: Health matters\./);
    assert.match(call, /Can you send the updated quote\?/);
    assert.match(call, /"ourTeam":\["Sam Owner <sam@us.com>"\]/);
  });

  it("keeps sensitive mail out and lets the rest in, with the score", async () => {
    assert.deepEqual(await decideSensitive(model(0.82), email, opts), { decision: "withhold", reason: "Looked sensitive (82% likely)", screened: true, score: 0.82 });
    assert.deepEqual(await decideSensitive(model(0.07), email, opts), { decision: "import", reason: "Screened (7% likely sensitive)", screened: true, score: 0.07 });
    // At 0.6, a 55% "maybe" goes in and 60% stays out.
    assert.equal((await decideSensitive(model(0.55), email, opts)).decision, "import");
    assert.equal((await decideSensitive(model(0.6), email, opts)).decision, "withhold");
  });

  it("lets mail in unscreened when the model fails", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const r = await decideSensitive(model(new Error("down")), email, opts);
      assert.deepEqual(r, { decision: "import", reason: "Not screened: the screen didn't answer", screened: false, score: null });
    } finally {
      console.error = original;
    }
  });
});
