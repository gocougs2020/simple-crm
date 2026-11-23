import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addRecent, parseRecent, type RecentRecord } from "./recent-records";

const ana: RecentRecord = { kind: "person", id: "1", label: "Ana Lee", detail: "Acme" };
const acme: RecentRecord = { kind: "organization", id: "2", label: "Acme" };
const deal: RecentRecord = { kind: "client", id: "3", label: "Acme renewal" };
const bolt: RecentRecord = { kind: "client", id: "4", label: "Bolt" };

describe("addRecent", () => {
  it("puts the newest first and keeps three", () => {
    let list: RecentRecord[] = [];
    for (const r of [ana, acme, deal, bolt]) list = addRecent(list, r);
    assert.deepEqual(list, [bolt, deal, acme]);
  });

  it("moves a record searched again to the top instead of listing it twice", () => {
    assert.deepEqual(addRecent([deal, acme, ana], { ...ana, label: "Ana Lee-Park" }), [{ ...ana, label: "Ana Lee-Park" }, deal, acme]);
  });

  it("tells records of different kinds with the same id apart", () => {
    assert.equal(addRecent([{ ...acme, id: "9" }], { ...deal, id: "9" }).length, 2);
  });
});

describe("parseRecent", () => {
  it("reads what addRecent wrote", () => {
    assert.deepEqual(parseRecent(JSON.stringify([ana, acme])), [ana, acme]);
  });

  it("drops anything malformed", () => {
    assert.deepEqual(parseRecent("not json"), []);
    assert.deepEqual(parseRecent(JSON.stringify({ kind: "person" })), []);
    assert.deepEqual(parseRecent(JSON.stringify([{ kind: "deal", id: "1", label: "x" }, { kind: "person", id: 1, label: "x" }, ana])), [ana]);
    assert.deepEqual(parseRecent(null), []);
  });

  it("keeps at most three", () => {
    assert.equal(parseRecent(JSON.stringify([ana, acme, deal, bolt])).length, 3);
  });
});
