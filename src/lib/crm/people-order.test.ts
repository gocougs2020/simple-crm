import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchesPerson, orderPeople } from "./people-order";

type P = { name: string; contact?: boolean; starred?: boolean };
const names = (list: P[]) => orderPeople(list, (p) => p).map((p) => p.name);

describe("ordering a record's people", () => {
  it("puts the contact first, then decision makers A to Z, then everyone else A to Z", () => {
    const list: P[] = [{ name: "zoe Quinn" }, { name: "Yuri Starr", starred: true }, { name: "Mia Contact", contact: true }, { name: "adam Best" }, { name: "Bea Star", starred: true }];
    assert.deepEqual(names(list), ["Mia Contact", "Bea Star", "Yuri Starr", "adam Best", "zoe Quinn"]);
  });

  it("keeps a starred contact at the top", () => {
    assert.deepEqual(names([{ name: "Ann", starred: true }, { name: "Zed", contact: true, starred: true }]), ["Zed", "Ann"]);
  });
});

describe("searching a picker", () => {
  const sam = { name: "Sam Lee", email: "sam@acme.com", detail: "VP Sales" };
  it("matches every word typed against the name, email and title", () => {
    assert.ok(matchesPerson("", sam));
    assert.ok(matchesPerson("lee", sam));
    assert.ok(matchesPerson("sam sales", sam));
    assert.ok(matchesPerson("ACME", sam));
    assert.ok(!matchesPerson("sam smith", sam));
  });
});
