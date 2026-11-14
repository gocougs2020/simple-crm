import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { siteUrlOrigin } from "./site-url";

describe("siteUrlOrigin", () => {
  it("keeps a full origin", () => {
    assert.equal(siteUrlOrigin("https://crm.example.com"), "https://crm.example.com");
  });
  it("adds https when the scheme is missing", () => {
    assert.equal(siteUrlOrigin("crm.example.com"), "https://crm.example.com");
    assert.equal(siteUrlOrigin(" crm.example.com/ "), "https://crm.example.com");
  });
  it("uses http for localhost without a scheme", () => {
    assert.equal(siteUrlOrigin("localhost:3200"), "http://localhost:3200");
  });
  it("drops trailing slashes and paths", () => {
    assert.equal(siteUrlOrigin("https://crm.example.com/"), "https://crm.example.com");
    assert.equal(siteUrlOrigin("https://crm.example.com/app"), "https://crm.example.com");
  });
  it("refuses what isn't a web URL", () => {
    assert.equal(siteUrlOrigin(""), null);
    assert.equal(siteUrlOrigin("ftp://crm.example.com"), null);
    assert.equal(siteUrlOrigin("https://"), null);
  });
});
