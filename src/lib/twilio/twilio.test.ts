import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { signingKeyAlgorithm, twilioSignature, validTwilioSignature } from "./signature";
import { el, twiml } from "./twiml";

describe("Twilio webhook signatures", () => {
  // Twilio's documented example.
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" };

  it("matches Twilio's own example", () => {
    assert.equal(twilioSignature("12345", url, params), "0/KCTR6DLpKmkAf8muzZqo1nDgQ=");
  });

  it("accepts the right signature on any of the URLs it might have been signed for", () => {
    const sig = twilioSignature("12345", url, params);
    assert.equal(validTwilioSignature("12345", sig, ["https://other.example/x", url], params), true);
  });

  it("refuses a missing, wrong or tampered signature", () => {
    const sig = twilioSignature("12345", url, params);
    assert.equal(validTwilioSignature("12345", null, [url], params), false);
    assert.equal(validTwilioSignature("wrong", sig, [url], params), false);
    assert.equal(validTwilioSignature("12345", sig, [url], { ...params, To: "+15555555555" }), false);
  });

  it("checks signing-key webhooks with any of the secrets (rotation) and the algorithm Twilio names", () => {
    const sig = twilioSignature("new-secret", url, params, "sha256");
    assert.equal(validTwilioSignature(["old-secret", "new-secret"], sig, [url], params, "sha256"), true);
    assert.equal(validTwilioSignature(["old-secret"], sig, [url], params, "sha256"), false);
    // A SHA-256 signature isn't accepted as SHA-1, or the other way round.
    assert.equal(validTwilioSignature(["new-secret"], sig, [url], params, "sha1"), false);
    assert.equal(validTwilioSignature([], sig, [url], params, "sha256"), false);
  });

  it("reads the signing key's algorithm from Twilio's header", () => {
    assert.equal(signingKeyAlgorithm(null), null);
    assert.equal(signingKeyAlgorithm("key=webhooks_sharedkey_01j9,algorithm=HMAC_SHA256"), "sha256");
    assert.equal(signingKeyAlgorithm("key=webhooks_sharedkey_01j9, algorithm=hmac_sha1"), "sha1");
    assert.equal(signingKeyAlgorithm("key=webhooks_sharedkey_01j9,algorithm=MD5"), "unknown");
    assert.equal(signingKeyAlgorithm("key=webhooks_sharedkey_01j9"), "unknown");
  });
});

describe("TwiML", () => {
  it("escapes every value, so a typed message can't change the instructions", () => {
    const xml = twiml(el("Say", undefined, `Hi <Hangup/> & "bye"`), el("Dial", { callerId: "+1303", answerOnBridge: true, timeout: 20, action: null }, el("Number", undefined, "+15551234567")));
    assert.equal(
      xml,
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Hi &lt;Hangup/&gt; &amp; &quot;bye&quot;</Say><Dial callerId="+1303" answerOnBridge="true" timeout="20"><Number>+15551234567</Number></Dial></Response>',
    );
  });
});
