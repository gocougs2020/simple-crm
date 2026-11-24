import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { productDescriber, productFamiliesOf, productFamily, productKey } from "./product-rules";

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

describe("productFamily", () => {
  it("groups products by the line their name says", () => {
    assert.equal(productFamily("TalentScout Starter"), "TalentScout");
    assert.equal(productFamily("CoRecruit Individual Coaching"), "CoRecruit");
    assert.equal(productFamily("ThirdPool Advanced Subscription"), "ThirdPool");
    assert.equal(productFamily("HiringCenter Starter"), "HiringCenter");
    assert.equal(productFamily("HiringCenter (no Recruitment Marketing)"), "HiringCenter");
    assert.equal(productFamily("Virtual Recruiting Assistant (VRA) Level A"), "VRA");
  });

  it("places the names that don't say it", () => {
    assert.equal(productFamily("Contract Recruiter Services"), "VRA");
    assert.equal(productFamily("Virtual Recruiting Assistant - Starter"), "VRA");
    assert.equal(productFamily("HiringCenter + Recruitment Marketing Level A (Starter)"), "ThirdPool");
    assert.equal(productFamily("Subscription"), "ThirdPool");
    assert.equal(productFamily("Recruit365"), "CoRecruit");
    assert.equal(productFamily("Recruit365 Subscription"), "CoRecruit");
  });

  it("leaves out products outside the five lines", () => {
    assert.equal(productFamily("Office Rental"), null);
    assert.equal(productFamily("Hiring Marketplace Subscription"), null);
  });

  it("lists a client's lines once, in order", () => {
    assert.deepEqual(productFamiliesOf(["Recruit365", "TalentScout Starter", "CoRecruit Group Coaching Program", "Test"]), ["TalentScout", "CoRecruit"]);
  });
});
