import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deviceLabel, isPushEndpoint } from "./device";
import { keyBytes } from "./client";

describe("push devices", () => {
  it("names devices people can tell apart", () => {
    assert.equal(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"), "Chrome on macOS");
    assert.equal(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", true), "Installed app on iPhone");
    assert.equal(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0"), "Edge on Windows");
    assert.equal(deviceLabel("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121 Mobile Safari/537.36"), "Samsung Internet on Android");
    assert.equal(deviceLabel(null), "This browser");
  });

  it("decodes URL-safe base64 VAPID keys", () => {
    assert.deepEqual([...keyBytes("AQID_-8")], [1, 2, 3, 255, 239]);
  });
});

describe("push endpoints", () => {
  it("only sends to browsers' push services", () => {
    for (const ok of ["https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com/Q", "https://db5p.notify.windows.com/w/?token=x"]) assert.equal(isPushEndpoint(ok), true, ok);
    for (const bad of ["http://fcm.googleapis.com/x", "https://fcm.googleapis.com.evil.com/x", "https://169.254.169.254/latest", "https://localhost/x", "https://fcm.googleapis.com:8443/x", "https://user:pw@fcm.googleapis.com/x", "not a url"]) assert.equal(isPushEndpoint(bad), false, bad);
  });
});
