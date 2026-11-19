import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { graphAddress, stripQuoted } from "./mail-text";
import { Experimental_DecisionMockModelV4 as MockDecisionModel } from "ai/test";
import { decideSensitive } from "./screen-decide";
import { screenQuestion, screenState } from "./screen-prompt";
import { internalDomains, isBlocked, outsiders, parseBlockList, visibilityFor } from "./sync-rules";

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

  it("sorts a probability into public, private or not stored", () => {
    const t = { private: 0.3, withhold: 0.85 };
    assert.equal(visibilityFor(0.05, t), "public");
    assert.equal(visibilityFor(0.3, t), "private");
    assert.equal(visibilityFor(0.84, t), "private");
    assert.equal(visibilityFor(0.85, t), "withhold");
    // A private threshold above the withhold one never widens what's public past it.
    assert.equal(visibilityFor(0.5, { private: 0.9, withhold: 0.6 }), "public");
    assert.equal(visibilityFor(0.6, { private: 0.9, withhold: 0.6 }), "withhold");
    assert.equal(visibilityFor(0.9, { private: Number.NaN, withhold: Number.NaN }), "withhold");
  });
});

describe("which mail the sync looks at", () => {
  const team = new Set(["sam@us.com", "pat@gmail.com"]);
  const domains = internalDomains(["sam@us.com", "pat@gmail.com"], ["@Sister.co"]);

  it("treats our own domains as ours, but never a public mail domain", () => {
    assert.deepEqual([...domains].sort(), ["sister.co", "us.com"]);
  });

  it("only counts people outside our organization", () => {
    // A colleague without a login, a teammate and a teammate on Gmail are all ours.
    assert.deepEqual(outsiders(["New.Hire@us.com", "sam@us.com", "pat@gmail.com", "x@sister.co"], team, domains), []);
    assert.deepEqual(outsiders(["sam@us.com", "Jo@Acme.com", "jo@acme.com", "kim@gmail.com", ""], team, domains), ["jo@acme.com", "kim@gmail.com"]);
  });

  it("reads a block list and matches addresses, domains and subdomains", () => {
    const { entries, invalid } = parseBlockList("Jo@Acme.com, @legal.co\nlegal.co\nnot an address!");
    assert.deepEqual(entries, ["jo@acme.com", "legal.co"]);
    assert.deepEqual(invalid, ["not", "an", "address!"]);
    assert.equal(isBlocked(["jo@acme.com"], entries), true);
    assert.equal(isBlocked(["sue@acme.com"], entries), false);
    assert.equal(isBlocked(["x@mail.legal.co"], entries), true);
    assert.equal(isBlocked(["x@notlegal.co"], entries), false);
    assert.equal(isBlocked(["x@legal.co"], []), false);
  });
});

describe("screening with a decision model", () => {
  const email = { from: "Jo <jo@acme.com>", to: ["sam@us.com"], subject: "Q3 pricing", text: "Can you send the updated quote?" };
  const opts = { sensitive: "Health matters.", workspaceName: "Acme", threshold: 0.6, privateThreshold: 0.3, timeoutMs: 2_000 };
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

  it("keeps sensitive mail out, keeps doubtful mail private and lets the rest in, with the score", async () => {
    assert.deepEqual(await decideSensitive(model(0.82), email, opts), { decision: "withhold", reason: "Looked sensitive (82% likely)", screened: true, score: 0.82 });
    assert.deepEqual(await decideSensitive(model(0.07), email, opts), { decision: "import", reason: "Screened (7% likely sensitive)", screened: true, score: 0.07 });
    assert.deepEqual(await decideSensitive(model(0.45), email, opts), { decision: "private", reason: "Might be sensitive (45% likely)", screened: true, score: 0.45 });
    assert.equal((await decideSensitive(model(0.29), email, opts)).decision, "import");
    assert.equal((await decideSensitive(model(0.6), email, opts)).decision, "withhold");
  });

  it("keeps mail private, unscreened, when the model fails", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const r = await decideSensitive(model(new Error("down")), email, opts);
      assert.deepEqual(r, { decision: "private", reason: "Not screened: the screen didn't answer", screened: false, score: null });
    } finally {
      console.error = original;
    }
  });
});
