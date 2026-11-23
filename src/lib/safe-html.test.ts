import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeSignatureHtml, signatureHasContent } from "./safe-html";

describe("Email signatures are sanitized", () => {
  it("keeps formatting, links, images, colors and sizes", () => {
    const html = `<p><strong>Jordan Lee</strong> · <em>Account Executive</em></p><p><span style="color: #1d4ed8; font-size: 18px">Acme</span> <a href="https://acme.com">acme.com</a></p><p><img src="https://acme.com/logo.png" alt="Acme" width="120" height="40"></p>`;
    assert.equal(
      sanitizeSignatureHtml(html),
      `<p><strong>Jordan Lee</strong> · <em>Account Executive</em></p><p><span style="color:#1d4ed8;font-size:18px">Acme</span> <a href="https://acme.com" target="_blank" rel="noopener noreferrer">acme.com</a></p><p><img src="https://acme.com/logo.png" alt="Acme" width="120" height="40"></p>`,
    );
  });

  it("drops scripts, event handlers, other styles and unsafe image sources", () => {
    const out = sanitizeSignatureHtml(
      `<p onclick="x()"><span style="background:url(javascript:x);color:red;position:fixed">Hi</span><img src="javascript:alert(1)"><img src="data:image/png;base64,AAA"><img src="https://x.com/a.png" onerror="x()" width="99999"><script>alert(1)</script><a href="javascript:x">bad</a></p>`,
    );
    assert.equal(out, `<p><span>Hi</span><img src="https://x.com/a.png" alt=""><a>bad</a></p>`);
  });

  it("counts an image alone as a signature, and empty paragraphs as none", () => {
    assert.ok(signatureHasContent(`<p><img src="https://x.com/a.png" alt=""></p>`));
    assert.ok(!signatureHasContent("<p></p><p> </p>"));
    assert.ok(!signatureHasContent(null));
  });
});
