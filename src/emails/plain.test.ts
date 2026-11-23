import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { plainEmailHtml } from "./plain";

describe("plainEmailHtml", () => {
  it("sends just the message: no background, card, logo or footer", () => {
    const out = plainEmailHtml("<p>Hi Sam,</p><p>Here's the <strong>proposal</strong>.</p>", null);
    assert.match(out, /^<html><head><meta charset="utf-8"><\/head><body><div style="font-family:Aptos[^"]*;font-size:12pt;color:#000000">/);
    assert.doesNotMatch(out, /background|border-radius|<img|<table/i);
    assert.ok(out.includes(`<p style="margin:0 0 1em">Hi Sam,</p>`));
  });

  it("leaves links to the reader's mail app", () => {
    assert.ok(plainEmailHtml(`<p><a href="https://example.com">site</a></p>`).includes(`<a href="https://example.com">site</a>`));
  });

  it("keeps empty lines the teammate typed", () => {
    assert.ok(plainEmailHtml("<p>One</p><p></p><p>Two</p>").includes(`<p style="margin:0 0 1em">&nbsp;</p>`));
  });

  it("adds the signature as plain lines, escaped", () => {
    const out = plainEmailHtml("<p>Thanks</p>", "Jordan Lee\nSales <Acme>\n");
    assert.ok(out.includes("<div>Jordan Lee<br>Sales &lt;Acme&gt;</div>"));
    assert.ok(!plainEmailHtml("<p>Thanks</p>", "  ").includes("<div></div>"));
  });

  it("adds a teammate's own signature as HTML, with tight lines and sized images", () => {
    const out = plainEmailHtml("<p>Thanks</p>", { html: `<p><strong>Jordan</strong></p><p></p><p><img src="https://acme.com/a.png" alt="" width="120"></p>` });
    assert.ok(out.includes(`<div><p style="margin:0"><strong>Jordan</strong></p><p style="margin:0">&nbsp;</p><p style="margin:0"><img src="https://acme.com/a.png" alt="" width="120" style="border:0;max-width:100%;height:auto"></p></div>`));
    assert.ok(!plainEmailHtml("<p>Thanks</p>", { html: " " }).includes("<div></div>"));
  });
});
