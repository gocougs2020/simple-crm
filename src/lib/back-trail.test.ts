import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canGoBackInApp, nextTrail } from "./back-trail";

const walk = (paths: string[]) => paths.reduce<string[]>((t, p) => nextTrail(t, p), []);

describe("back trail", () => {
  it("can go back after moving within the CRM", () => {
    assert.equal(canGoBackInApp(walk(["/people", "/people/a"]), undefined), true);
  });

  it("can't go back from a record opened directly", () => {
    assert.equal(canGoBackInApp(walk(["/people/a"]), undefined), false);
  });

  it("returning to the first page shrinks the trail, so back opens the list instead of leaving", () => {
    const t = walk(["/people/a", "/organizations/b", "/people/a"]);
    assert.deepEqual(t, ["/people/a"]);
    assert.equal(canGoBackInApp(t, undefined), false);
  });

  it("a re-render on the same page changes nothing", () => {
    assert.deepEqual(walk(["/people", "/people/a", "/people/a"]), ["/people", "/people/a"]);
  });

  it("trusts the Navigation API when the browser has it", () => {
    assert.equal(canGoBackInApp(["/a", "/b"], { canGoBack: false }), false);
    assert.equal(canGoBackInApp(["/a"], { canGoBack: true }), true);
  });
});
