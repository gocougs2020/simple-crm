import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { followMerges, inWindow, mergedInto, OrganizationMatcher, parseSince, PersonMatcher } from "./pipedrive-sync";

const now = new Date("2026-11-22T12:00:00Z");

describe("parseSince", () => {
  it("reads days back from now, with or without a d", () => {
    assert.equal(parseSince("14", now)?.toISOString(), "2026-11-08T12:00:00.000Z");
    assert.equal(parseSince("14d", now)?.toISOString(), "2026-11-08T12:00:00.000Z");
  });
  it("reads a date as the start of that day, UTC", () => {
    assert.equal(parseSince("2026-11-08", now)?.toISOString(), "2026-11-08T00:00:00.000Z");
  });
  it("is undefined when not given, and refuses anything else", () => {
    assert.equal(parseSince(undefined, now), undefined);
    for (const bad of ["", "0", "two weeks", "-3", "2026-13-45"]) assert.throws(() => parseSince(bad, now), /--since takes/);
  });
});

describe("inWindow", () => {
  const since = new Date("2026-11-08T00:00:00Z");
  it("keeps times on or after the start", () => {
    assert.equal(inWindow(new Date("2026-11-08T00:00:00Z"), since), true);
    assert.equal(inWindow(new Date("2026-11-07T23:59:59Z"), since), false);
  });
  it("counts unknown times as outside, and everything as inside without a window", () => {
    assert.equal(inWindow(null, since), false);
    assert.equal(inWindow(null, undefined), true);
  });
});

describe("following merges", () => {
  const into = mergedInto([
    { entityId: "b", data: { merged: [{ id: "a", name: "Acme" }], deleted: [{ id: "a2", name: "Acme" }] } },
    { entityId: "c", data: { merged: [{ id: "b", name: "Acme" }] } },
    { entityId: "x", data: { merged: "not a list" } },
  ]);
  const exists = (id: string) => ["c", "z"].includes(id);
  it("goes from a merged-away record to the one that's kept, through merges of merges", () => {
    assert.equal(followMerges("a", exists, into), "c");
    assert.equal(followMerges("a2", exists, into), "c");
    assert.equal(followMerges("b", exists, into), "c");
  });
  it("keeps a record that still exists, and gives null for one that's gone with no merge", () => {
    assert.equal(followMerges("z", exists, into), "z");
    assert.equal(followMerges("gone", exists, into), null);
    assert.equal(followMerges(null, exists, into), null);
  });
  it("doesn't loop on a cycle", () => {
    const loop = mergedInto([
      { entityId: "p", data: { merged: [{ id: "q" }] } },
      { entityId: "q", data: { merged: [{ id: "p" }] } },
    ]);
    assert.equal(followMerges("p", () => false, loop), null);
  });
});

describe("PersonMatcher", () => {
  const here = new PersonMatcher([
    { id: "ada", firstName: "Ada", lastName: "Lovelace", email: "ada@acme.com", phone: "(555) 010-2000", otherEmails: ["ada.l@gmail.com"], otherPhones: [] },
    { id: "front", firstName: "Front", lastName: "Desk", email: "info@acme.com", phone: "555-010-9999" },
    { id: "front2", firstName: "Reception", lastName: null, email: "info@acme.com", phone: null },
  ]);
  it("matches the same name with a shared email or phone, in any format", () => {
    assert.equal(here.find({ firstName: "ada", lastName: "lovelace", email: null, phone: "+1 555 010 2000" }), "ada");
    assert.equal(here.find({ firstName: "Ada", lastName: "Lovelace", email: "ADA.L@gmail.com", phone: null }), "ada");
  });
  it("matches an email only one person here has, whatever the name", () => {
    assert.equal(here.find({ firstName: "A.", lastName: "Lovelace", email: "ada@acme.com", phone: null }), "ada");
    assert.equal(here.find({ firstName: "Someone", lastName: null, email: null, phone: null, otherEmails: ["ada.l@gmail.com"] }), "ada");
  });
  it("doesn't match a shared inbox, a phone alone or a name alone", () => {
    assert.equal(here.find({ firstName: "Bob", lastName: null, email: "info@acme.com", phone: null }), null);
    assert.equal(here.find({ firstName: "Bob", lastName: null, email: null, phone: "555-010-2000" }), null);
    assert.equal(here.find({ firstName: "Ada", lastName: "Lovelace", email: null, phone: null }), null);
  });
  it("finds a person by the emails and phones a match gave them, under their own name", () => {
    const m = new PersonMatcher([{ id: "ada", firstName: "Ada", lastName: "Lovelace", email: "ada@acme.com", phone: null }]);
    const incoming = { firstName: "Ada", lastName: "L.", email: "ada@acme.com", phone: "555-123-4567" };
    assert.equal(m.find(incoming), "ada");
    assert.equal(m.find({ firstName: "Ada", lastName: "Lovelace", email: null, phone: "555-123-4567" }), null);
    m.extend("ada", incoming);
    assert.equal(m.find({ firstName: "Ada", lastName: "Lovelace", email: null, phone: "555-123-4567" }), "ada");
  });
  it("finds people added during the run", () => {
    here.add({ id: "new", firstName: "Grace", lastName: "Hopper", email: "grace@navy.mil", phone: null });
    assert.equal(here.find({ firstName: "Grace", lastName: "Hopper", email: "grace@navy.mil", phone: null }), "new");
  });
});

describe("OrganizationMatcher", () => {
  it("matches the whole name ignoring capitals and spaces at the ends, first one added wins", () => {
    const here = new OrganizationMatcher([
      { id: "kept", name: "Acme Corp" },
      { id: "later", name: "acme corp" },
    ]);
    assert.equal(here.find("  ACME corp "), "kept");
    assert.equal(here.find("Acme"), null);
    assert.equal(here.find(null), null);
  });
});
