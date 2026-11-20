import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deviceLabel, isPushEndpoint } from "./device";
import { keyBytes } from "./client";
import { activityVerb, chatTargets, noteTargets, stageTitle } from "./routing";
import { defaultNotificationKinds, notificationGroups, notificationKinds } from "@/lib/constants";

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

describe("who hears about what", () => {
  const owners = [{ userId: "owner", name: "Acme", url: "/clients/c1" }];
  const kinds = (targets: { userId: string; notices: { kind: string }[] }[], id: string) => targets.find((t) => t.userId === id)?.notices.map((n) => n.kind);

  it("offers a note's mention first, then the thread, then the record's owner, once each", () => {
    const t = noteTargets({ who: "Sam", body: "Hi", url: "/clients/c1", dedupeKey: "note:r1", reply: true, mentioned: ["owner", "pat"], thread: ["author", null, "pat"], owners });
    assert.deepEqual(kinds(t, "owner"), ["note_mention", "owned_activity"]);
    assert.deepEqual(kinds(t, "pat"), ["note_mention", "note_reply"]);
    assert.deepEqual(kinds(t, "author"), ["note_reply"]);
    assert.equal(t.length, 3);
    assert.ok(t.every((x) => x.notices.every((n) => n.dedupeKey === "note:r1")), "one key per teammate, so a fallback can't send twice");
    assert.equal(t.find((x) => x.userId === "owner")?.notices[1].title, "Sam replied to a note on Acme");
  });

  it("tells a record's owner about a new note that mentions nobody", () => {
    const t = noteTargets({ who: "Sam", body: "Hi", url: "/clients/c1", dedupeKey: "note:n1", reply: false, mentioned: [], thread: [], owners });
    assert.deepEqual(t, [{ userId: "owner", notices: [{ kind: "owned_activity", title: "Sam added a note on Acme", body: "Hi", url: "/clients/c1", dedupeKey: "note:n1" }] }]);
  });

  it("words logged and planned activity", () => {
    assert.equal(activityVerb("call", true), "logged a call");
    assert.equal(activityVerb("email", true), "logged an email");
    assert.equal(activityVerb("meeting", false), "planned a meeting");
    assert.equal(activityVerb("task", false), "added a task");
    assert.equal(stageTitle("Sam", "Acme", "Proposal"), "Sam moved Acme to Proposal");
    assert.equal(stageTitle("Sam", "Acme", "Onboarding", "current"), "Sam signed Acme");
  });

  it("sends a chat mention before the plain message, and each listener one alert", () => {
    const mention = { kind: "chat_mention" as const, title: "m", url: "/chat", dedupeKey: "chat:1" };
    const message = { kind: "chat_message" as const, title: "c", url: "/chat", dedupeKey: "chat:1" };
    const t = chatTargets(["pat"], ["pat", "lee"], { mention, message });
    assert.deepEqual(kinds(t, "pat"), ["chat_mention", "chat_message"]);
    assert.deepEqual(kinds(t, "lee"), ["chat_message"]);
    assert.equal(t.length, 2);
  });

  it("groups every alert exactly once, and leaves every chat message off for new devices", () => {
    const grouped = notificationGroups.flatMap((g) => g.kinds);
    assert.deepEqual([...grouped].sort(), [...notificationKinds].sort());
    assert.equal(new Set(grouped).size, grouped.length);
    assert.ok(!defaultNotificationKinds.includes("chat_message"));
  });
});
