import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inAppPath } from "./links";

const origin = "https://crm.example.com";

describe("links in the agent's answers", () => {
  it("opens this site's pages in place, written as a path or in full", () => {
    assert.equal(inAppPath("/clients/abc", origin), "/clients/abc");
    assert.equal(inAppPath("https://crm.example.com/people/abc?draft=1#top", origin), "/people/abc?draft=1#top");
    assert.equal(inAppPath("https://crm.example.com", origin), "/");
  });

  it("leaves other sites, downloads and odd addresses to a new tab", () => {
    assert.equal(inAppPath("https://example.org/clients/abc", origin), null);
    assert.equal(inAppPath("http://crm.example.com/clients/abc", origin), null);
    assert.equal(inAppPath("//example.org/x", origin), null);
    assert.equal(inAppPath("https://crm.example.com//example.org/x", origin), null);
    assert.equal(inAppPath("/\\example.org", origin), null);
    assert.equal(inAppPath("https://crm.example.com/api/files/abc", origin), null);
    assert.equal(inAppPath("/api/files/abc", origin), null);
    assert.equal(inAppPath("javascript:alert(1)", origin), null);
    assert.equal(inAppPath("mailto:sam@example.com", origin), null);
    assert.equal(inAppPath(undefined, origin), null);
  });
});
