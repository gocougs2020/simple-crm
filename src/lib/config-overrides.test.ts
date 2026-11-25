import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appConfig, type AppConfig } from "../../app.config";
import { applyConfigOverrides, isSafeCssValue } from "./config-overrides";
import { themeStyleSheet } from "./theme-css";

const defaults: AppConfig = {
  brand: { name: "CRM", description: "Default" },
  theme: { brandColor: null, brandForeground: "#ffffff", tokens: {}, browserColor: "#fafafa" },
  layout: { defaultClientsView: "board" },
  email: { trackOpens: false, trackClicks: false },
  agent: { enabled: true, freshChatMinutes: 5, voice: true, dictation: true, summaries: true, fileDescriptions: true, name: "Assistant", mentionName: "Assistant", chatModel: "a/chat", chatReasoning: "medium", summaryModel: "a/sum", summaryReasoning: "low", titleModel: "a/title", fileModel: "a/file", fileReasoning: "low", embeddingModel: "a/embed", voiceModel: "a/voice", transcriptionModel: "a/stt", suggestions: ["One"], viewerSuggestions: ["Two"], background: { enabled: true, model: "a/work", reasoning: "low", researchModel: "a/research", researchReasoning: "high", maxRunUsd: 0.75, monthlyBudgetUsd: 30, maxRunMinutes: 20, maxConcurrentPerUser: 3, maxBulkRecords: 50, clearAfterMinutes: 60 }, forwarding: { enabled: true, mailbox: "", perHour: 20, maxRounds: 8, maxChars: 40_000, maxAgeDays: 3 } },
  notifications: { morningHour: 7 },
  live: { pollSeconds: 30, idleMinutes: 10, chatPollSeconds: 5 },
  analytics: { webAnalytics: true, speedInsights: true, speedInsightsSampleRate: 1 },
  records: { keyContactLabel: "Decision maker" },
  microsoft: {
    enabled: true,
    syncEveryMinutes: 15,
    firstSyncDays: 14,
    syncSent: true,
    screenMail: true,
    screenModel: "a/screen",
    screenInstructions: "Private things.",
    privateThreshold: 0.3,
    screenThreshold: 0.6,
    internalDomains: [],
    withheldCategory: null,
    calendarTypes: ["meeting"],
    calendarDefaultMinutes: 30,
    inviteContacts: false,
  },
  phone: { enabled: true, defaultCountryCode: "1", numberCountry: "US", forwardCallerId: "caller", forwardTimeoutSeconds: 25, missedCallMessage: null, textCampaignsNeedConsent: true, textCampaignFooter: "Reply STOP to opt out." },
  pwa: { shortName: null, iconBackground: null, iconForeground: "#ffffff", backgroundColor: "#fafafa" },
};

describe("applyConfigOverrides", () => {
  it("configures Microsoft 365 and the phone per deployment", () => {
    const merged = applyConfigOverrides(defaults, {
      json: JSON.stringify({ microsoft: { syncEveryMinutes: 30, screenThreshold: 0.7, withheldCategory: "Kept out", calendarTypes: ["meeting", "call"] }, phone: { forwardCallerId: "number", missedCallMessage: "Leave a message." }, records: { keyContactLabel: "Key contact" } }),
    });
    assert.equal(merged.microsoft.syncEveryMinutes, 30);
    assert.equal(merged.microsoft.screenThreshold, 0.7);
    assert.equal(merged.microsoft.withheldCategory, "Kept out");
    assert.deepEqual(merged.microsoft.calendarTypes, ["meeting", "call"]);
    assert.equal(merged.phone.forwardCallerId, "number");
    assert.equal(merged.phone.missedCallMessage, "Leave a message.");
    assert.equal(merged.records.keyContactLabel, "Key contact");
    assert.throws(() => applyConfigOverrides(defaults, { json: '{"phone":{"forwardCallerId":"cell"}}' }), /phone\.forwardCallerId: expected one of/);
    assert.throws(() => applyConfigOverrides(defaults, { json: '{"microsoft":{"screenMail":"yes"}}' }), /microsoft\.screenMail: expected boolean/);
  });

  it("returns the defaults untouched when nothing is set", () => {
    assert.equal(applyConfigOverrides(defaults, {}), defaults);
    assert.equal(applyConfigOverrides(defaults, { json: " ", name: "" }), defaults);
  });

  it("deep-merges JSON and applies shortcuts last", () => {
    const merged = applyConfigOverrides(defaults, {
      json: JSON.stringify({ brand: { name: "From JSON" }, layout: { defaultClientsView: "table" } }),
      name: " Acme CRM ",
      brandColor: "#2f629f",
    });
    assert.deepEqual(merged.brand, { name: "Acme CRM", description: "Default" });
    assert.equal(merged.layout.defaultClientsView, "table");
    assert.equal(merged.theme.brandColor, "#2f629f");
    assert.equal(defaults.brand.name, "CRM");
  });

  it("turns email tracking on with booleans only", () => {
    const merged = applyConfigOverrides(defaults, { json: '{"email":{"trackOpens":true}}' });
    assert.deepEqual(merged.email, { trackOpens: true, trackClicks: false });
    assert.throws(() => applyConfigOverrides(defaults, { json: '{"email":{"trackClicks":"yes"}}' }), /email\.trackClicks: expected boolean, got string/);
  });

  it("allows new theme tokens but no other unknown keys", () => {
    const merged = applyConfigOverrides(defaults, { json: '{"theme":{"tokens":{"canvas":"#f7f5f0"}}}' });
    assert.deepEqual(merged.theme.tokens, { canvas: "#f7f5f0" });
    assert.throws(() => applyConfigOverrides(defaults, { json: '{"brand":{"logo":"x"}}' }), /brand\.logo: not a setting/);
  });

  it("checks types and enums, and reports every problem at once", () => {
    assert.throws(
      () => applyConfigOverrides(defaults, { json: '{"brand":{"name":1},"layout":{"defaultClientsView":"list"}}' }),
      (error: Error) =>
        /brand\.name: expected string/.test(error.message) && /defaultClientsView: expected one of "board", "table"/.test(error.message),
    );
  });

  it("checks the agent and installed-app settings", () => {
    const merged = applyConfigOverrides(defaults, { json: '{"agent":{"name":"Ada","suggestions":["Hi"]},"pwa":{"shortName":"Acme","iconBackground":"#2f629f"}}' });
    assert.equal(merged.agent.name, "Ada");
    assert.deepEqual(merged.agent.suggestions, ["Hi"]);
    assert.equal(merged.pwa.shortName, "Acme");
    assert.throws(() => applyConfigOverrides(defaults, { json: '{"pwa":{"iconBackground":"red;}"}}' }), /pwa\.iconBackground/);
    assert.throws(() => applyConfigOverrides(defaults, { json: '{"agent":{"enabled":"yes"}}' }), /agent\.enabled: expected boolean/);
    assert.equal(applyConfigOverrides(defaults, { json: '{"agent":{"chatReasoning":"high"}}' }).agent.chatReasoning, "high");
    const off = applyConfigOverrides(defaults, { json: '{"agent":{"voice":false,"summaries":false}}' }).agent;
    assert.deepEqual([off.enabled, off.voice, off.dictation, off.summaries], [true, false, true, false]);
    assert.throws(() => applyConfigOverrides(defaults, { json: '{"agent":{"chatReasoning":"extreme"}}' }), /agent\.chatReasoning: expected one of/);
  });

  it("refuses invalid JSON and CSS that could escape the style tag", () => {
    assert.throws(() => applyConfigOverrides(defaults, { json: "{" }), /not valid JSON/);
    assert.throws(() => applyConfigOverrides(defaults, { brandColor: "red;}</style>" }), /theme\.brandColor/);
    assert.throws(() => applyConfigOverrides(defaults, { json: '{"theme":{"tokens":{"a;b":"red"}}}' }), /token names/);
  });
});

describe("isSafeCssValue", () => {
  for (const ok of ["#2f629f", "oklch(0.55 0.15 250)", "rgb(0 0 0 / 10%)", "color-mix(in oklab, red 50%, white)"]) {
    it(`allows ${ok}`, () => assert.equal(isSafeCssValue(ok), true));
  }
  for (const bad of ["", "red;", "a{b}", "url('x')", "url(//evil.example/x)", "image-set(a)", "</style>"]) {
    it(`refuses ${JSON.stringify(bad)}`, () => assert.equal(isSafeCssValue(bad), false));
  }
});

describe("themeStyleSheet", () => {
  it("is empty for the default theme", () => {
    assert.equal(themeStyleSheet(appConfig.theme), "");
  });

  it("derives the accent family from one brand color, with explicit tokens winning", () => {
    const css = themeStyleSheet({ ...defaults.theme, brandColor: "#2f629f", tokens: { ring: "#000" } });
    assert.match(css, /^html:root\{/);
    assert.match(css, /--accent:#2f629f;/);
    assert.match(css, /--accent-hover:color-mix\(in oklab, #2f629f 85%, black\)/);
    assert.match(css, /--accent-soft:color-mix\(in oklab, #2f629f 10%, white\)/);
    assert.match(css, /--ring:#000/);
  });
});
