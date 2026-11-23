import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { productDescriber, productKey } from "./product-rules";

describe("productDescriber", () => {
  const describe_ = productDescriber([{ name: "ThirdPool Advanced", description: "Weekly shortlist, 30-day fill." }]);

  it("finds a product by its Stripe name, whatever the case", () => {
    assert.equal(describe_("ThirdPool Advanced"), "Weekly shortlist, 30-day fill.");
    assert.equal(describe_(" thirdpool advanced "), "Weekly shortlist, 30-day fill.");
  });

  it("says nothing for a product nobody described", () => {
    assert.equal(describe_("ThirdPool Starter"), null);
  });

  it("keys on the trimmed, lowercased name", () => {
    assert.equal(productKey("  CoRecruit "), "corecruit");
  });
});
