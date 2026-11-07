import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appConfig, type AppConfig } from "../../app.config";
import { applyConfigOverrides, isSafeCssValue } from "./config-overrides";
import { themeStyleSheet } from "./theme-css";

const defaults: AppConfig = {
  brand: { name: "CRM", description: "Default" },
  theme: { brandColor: null, brandForeground: "#ffffff", tokens: {}, browserColor: "#fafafa" },
  layout: { defaultClientsView: "board" },
};

describe("applyConfigOverrides", () => {
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
