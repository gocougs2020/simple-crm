import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { latestVersions, liveAction, movedScopes, noVersions, pageScopes } from "./live-rules";

const v = (records: string, chat: string, mail: string) => ({ records, chat, mail });

describe("live scopes", () => {
  it("knows what each page shows", () => {
    assert.deepEqual(pageScopes("/"), ["records"]);
    assert.deepEqual(pageScopes("/clients/abc"), ["records"]);
    assert.deepEqual(pageScopes("/email"), ["records", "mail"]);
    assert.deepEqual(pageScopes("/messages"), ["records", "mail"]);
    assert.deepEqual(pageScopes("/email/campaigns"), ["records"]);
    assert.deepEqual(pageScopes("/chat"), []);
    assert.deepEqual(pageScopes("/files"), ["records", "chat"]);
  });

  it("finds what moved, comparing as numbers", () => {
    assert.deepEqual(movedScopes(v("9", "5", "5"), v("10", "5", "5")), ["records"]);
    assert.deepEqual(movedScopes(v("10", "5", "5"), v("9", "5", "6")), ["mail"]);
    assert.deepEqual(movedScopes(v("1", "1", "1"), v("1", "1", "1")), []);
  });

  it("keeps the newest of each, and ignores what isn't a version", () => {
    assert.deepEqual(latestVersions(v("10", "5", "5"), v("9", "6", "5")), v("10", "6", "5"));
    assert.deepEqual(latestVersions(v("10", "5", "5"), { chat: "7" }), v("10", "7", "5"));
    assert.deepEqual(latestVersions(noVersions, { records: "abc" }), noVersions);
  });

  it("refreshes the page only for what it shows, else just the badges", () => {
    assert.equal(liveAction(["records"], "/people"), "refresh");
    assert.equal(liveAction(["chat"], "/people"), "badges");
    assert.equal(liveAction(["mail"], "/clients/abc"), "badges");
    assert.equal(liveAction(["mail"], "/email"), "refresh");
    assert.equal(liveAction(["records"], "/chat"), "badges");
    assert.equal(liveAction(["chat"], "/chat"), "badges");
    assert.equal(liveAction([], "/people"), "none");
  });
});
