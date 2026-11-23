import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emailText, forwardedAddresses, linkAddresses } from "./forwarded";

describe("forwardedAddresses", () => {
  it("reads Gmail's forwarded block", () => {
    const text = [
      "Can you log this on Fox & Roach?",
      "",
      "---------- Forwarded message ---------",
      "From: Sheila McCool <Sheila.McCool@foxroach.com>",
      "Date: Mon, Nov 23, 2026 at 7:22 AM",
      "Subject: Re: Invoice",
      "To: Recruiting Insight <solutions@recruitinginsight.net>",
      "Cc: Camryn Brown <camryn.brown@foxroach.com>, ap@foxroach.com",
      "",
      "Good morning, I checked with A/P and this invoice was paid.",
    ].join("\n");
    assert.deepEqual(forwardedAddresses(text), ["sheila.mccool@foxroach.com", "solutions@recruitinginsight.net", "camryn.brown@foxroach.com", "ap@foxroach.com"]);
  });

  it("reads Outlook's headers, bold labels and wrapped recipients included", () => {
    const text = ["FYI", "", "*From:* Adi Kaveria <adi.kaveria@foxroach.com>", "*Sent:* Monday, November 23, 2026 8:40 AM", "*To:* Logan <logan@example.com>; Pat <pat@example.com>;", "    Sam <sam@example.com>", "*Subject:* Campaign"].join("\n");
    assert.deepEqual(forwardedAddresses(text), ["adi.kaveria@foxroach.com", "logan@example.com", "pat@example.com", "sam@example.com"]);
  });

  it("reads the attribution line above a quote", () => {
    assert.deepEqual(forwardedAddresses("Thanks\n\nOn Fri, Jul 24, 2026 at 2:31 PM Stephanie <stephanie@example.com> wrote:\n> Hi"), ["stephanie@example.com"]);
  });

  it("ignores addresses in the body and quoted text that aren't headers", () => {
    assert.deepEqual(forwardedAddresses("Write to help@example.com\n> from now on, email me at a@b.com"), []);
    assert.deepEqual(forwardedAddresses(null), []);
  });
});

describe("emailText", () => {
  it("keeps an HTML-only forward's headers on their own lines", () => {
    const html =
      '<div dir="ltr">Log this please<br><div class="gmail_quote"><div>---------- Forwarded message ---------</div><div>From: <strong>Sheila McCool</strong> &lt;<a href="mailto:sheila@foxroach.com">sheila@foxroach.com</a>&gt;</div><div>Date: Mon, Nov 23, 2026</div><div>To: Recruiting Insight &lt;solutions@ri.net&gt;</div><div>Cc: &lt;ap@foxroach.com&gt;</div></div></div>';
    assert.deepEqual(forwardedAddresses(emailText({ text: null, html })), ["sheila@foxroach.com", "solutions@ri.net", "ap@foxroach.com"]);
  });

  it("prefers the plain-text part", () => {
    assert.equal(emailText({ text: "From: a@b.com", html: "<div>From: c@d.com</div>" }), "From: a@b.com");
  });
});

describe("linkAddresses", () => {
  const team = new Set(["logan@ri.net", "rhonda@ri.net"]);

  it("looks up who a teammate forwarded, not the teammate", () => {
    assert.deepEqual(linkAddresses(["logan@ri.net"], team, ["sheila@foxroach.com", "rhonda@ri.net"]), ["sheila@foxroach.com"]);
  });

  it("keeps outside participants first, once each", () => {
    assert.deepEqual(linkAddresses(["ana@acme.com", "logan@ri.net"], team, ["ana@acme.com", "ben@acme.com"]), ["ana@acme.com", "ben@acme.com"]);
  });

  it("falls back to everyone when only teammates are on it", () => {
    assert.deepEqual(linkAddresses(["logan@ri.net"], team, []), ["logan@ri.net"]);
  });
});
