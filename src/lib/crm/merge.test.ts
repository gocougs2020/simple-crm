import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { distinct, personMatchKeys, emailKey, fillGaps, groupByName, groupClients, pickClientSurvivor, planClientMerge, type ClientFields, groupByShared, keepContactsOnImport, mergeCustom, phoneKey, pickSurvivor, planOrganizationMerge, planPersonMerge, type OrgFields, type PersonFields } from "./merge";

const day = (n: number) => new Date(Date.UTC(2024, 0, n));

const org = (id: string, n: number, extra: Partial<OrgFields> = {}): OrgFields => ({
  id,
  createdAt: day(n),
  name: "Acme",
  domain: null,
  phone: null,
  address: null,
  industry: null,
  ownerId: null,
  custom: {},
  lastActivityAt: null,
  archivedAt: null,
  ...extra,
});

const person = (id: string, n: number, extra: Partial<PersonFields> = {}): PersonFields => ({
  id,
  createdAt: day(n),
  firstName: "Ada",
  lastName: null,
  email: null,
  phone: null,
  otherEmails: [],
  otherPhones: [],
  title: null,
  organizationId: null,
  ownerId: null,
  tags: [],
  custom: {},
  marketingOptIn: true,
  unsubscribedAt: null,
  emailBouncedAt: null,
  lastCampaignAt: null,
  decisionMaker: false,
  textConsentAt: null,
  textOptOutAt: null,
  lastActivityAt: null,
  archivedAt: null,
  ...extra,
});

const client = (id: string, n: number, extra: Partial<ClientFields> = {}): ClientFields => ({
  id,
  createdAt: day(n),
  name: "Acme",
  category: "prospective",
  value: 0,
  expectedCloseDate: null,
  startedOn: null,
  endedOn: null,
  churnReason: null,
  health: null,
  tags: [],
  personId: null,
  organizationId: "org1",
  ownerId: null,
  custom: {},
  lastActivityAt: null,
  archivedAt: null,
  ...extra,
});

describe("finding duplicates", () => {
  it("groups organizations on the whole name, ignoring capitals", () => {
    const groups = groupByName([org("a", 3), org("b", 1), org("c", 2, { name: "Acme Inc" }), org("d", 4, { name: "acme" }), org("e", 5, { name: "ACME INC " }), org("f", 6, { name: "Acme Incorporated" })]);
    assert.deepEqual(
      groups.map((g) => g.map((r) => r.id)),
      [
        ["b", "a", "d"],
        ["c", "e"],
      ],
    );
  });

  it("compares emails without case and phones on their last 10 digits", () => {
    assert.equal(emailKey("  Ada@Example.COM "), "ada@example.com");
    assert.equal(phoneKey("(303) 555-0123"), phoneKey("+1 303.555.0123 x12"));
    assert.equal(phoneKey("123"), "");
  });

  it("groups people with the same name who share an email or phone, through each other too", () => {
    const rows = [
      person("a", 1, { lastName: "Lovelace", email: "ada@x.com" }),
      person("b", 2, { firstName: "ADA", lastName: " Lovelace", email: "ADA@x.com", phone: "303-555-0123" }),
      person("c", 3, { lastName: "Lovelace", phone: "+13035550123" }),
      person("d", 4, { firstName: "A.", lastName: "Lovelace", phone: "303-555-0123" }),
      person("e", 5, { firstName: "Grace", email: "grace@x.com", otherPhones: ["(720) 555-0000"] }),
      person("f", 6, { firstName: "Grace", phone: "720 555 0000" }),
      person("g", 7, { firstName: "Bob", phone: "720 555 0000" }),
      person("h", 8, { firstName: "Rob", phone: "12" }),
      person("i", 9, { firstName: "Rob", phone: "12" }),
    ];
    const groups = groupByShared(rows, personMatchKeys);
    assert.deepEqual(
      groups.map((g) => g.map((r) => r.id)),
      [
        ["a", "b", "c"],
        ["e", "f"],
      ],
    );
  });

  it("keeps the oldest record with something on it", () => {
    const group = [org("old-empty", 1), org("middle", 2), org("newest", 3)];
    const { survivor, merged, empty } = pickSurvivor(group, (r) => r.id !== "old-empty");
    assert.equal(survivor.id, "middle");
    assert.deepEqual(
      merged.map((r) => r.id),
      ["newest"],
    );
    assert.deepEqual(
      empty.map((r) => r.id),
      ["old-empty"],
    );
    assert.equal(pickSurvivor(group, () => false).survivor.id, "old-empty");
  });

  it("fills blanks from records with something on them first, newest first, then empty ones", () => {
    const group = [org("keep", 1), org("old-empty", 2, { domain: "empty-old.com" }), org("active-old", 3, { domain: "active-old.com" }), org("active-new", 4, { domain: "active-new.com" }), org("new-empty", 5, { domain: "empty-new.com", address: "9 Late St" })];
    const plan = pickSurvivor(group, (r) => r.id.startsWith("keep") || r.id.startsWith("active"));
    assert.deepEqual(
      plan.donors.map((r) => r.id),
      ["active-new", "active-old", "new-empty", "old-empty"],
    );
    assert.deepEqual(planOrganizationMerge(plan.survivor, plan.donors), { domain: "active-new.com", address: "9 Late St" });
  });
});

describe("combining duplicates", () => {
  it("fills only blank fields, from the oldest source that has them", () => {
    const target: Record<"a" | "b" | "c", string | null> = { a: "kept", b: null, c: "" };
    assert.deepEqual(fillGaps(target, [{ a: "x", b: null, c: "first" }, { b: "second", c: "later" }], ["a", "b", "c"] as const), { b: "second", c: "first" });
    assert.deepEqual(mergeCustom({ size: 10, tier: null }, [{ size: 20, tier: "gold", region: "west" }]), { size: 10, tier: "gold", region: "west" });
    assert.equal(mergeCustom({ size: 10 }, [{ size: 20 }]), null);
  });

  it("keeps a merged parent organization's standing, and never leaves a parent with a parent", () => {
    // A franchise merged into its parent's duplicate: the kept one becomes the parent and drops its own.
    assert.deepEqual(planOrganizationMerge(org("a", 1, { parentId: "b" }), [org("b", 2, { isParent: true })]), { isParent: true, parentId: null });
    // Two franchises: the kept one takes the other's parent when it has none.
    assert.deepEqual(planOrganizationMerge(org("a", 1), [org("b", 2, { parentId: "p" })]), { parentId: "p" });
    assert.deepEqual(planOrganizationMerge(org("a", 1, { parentId: "p" }), [org("b", 2, { parentId: "q" })]), {});
  });

  it("keeps an organization's details and fills its gaps", () => {
    const patch = planOrganizationMerge(org("a", 1, { domain: "acme.com", archivedAt: day(9) }), [org("b", 2, { domain: "other.com", address: "1 Main St", lastActivityAt: day(20) })]);
    assert.deepEqual(patch, { address: "1 Main St", lastActivityAt: day(20), archivedAt: null });
  });

  it("keeps every email and phone of the group, the survivor's as the main ones", () => {
    const { patch, alsoAt } = planPersonMerge(
      person("a", 1, { email: "ada@x.com", phone: "303-555-0123", organizationId: "org1", tags: ["vip"] }),
      [
        person("b", 2, { email: "ADA@x.com", otherEmails: ["ada@home.com"], phone: "+1 (303) 555-0123", organizationId: "org2", tags: ["vip", "west"], textOptOutAt: day(5) }),
        person("c", 3, { email: "lovelace@y.com", phone: "720-555-0000", organizationId: "org1", marketingOptIn: false, decisionMaker: true }),
      ],
      { survivor: ["org3"], others: ["org2"] },
    );
    assert.equal(patch.email, undefined);
    assert.deepEqual(patch.otherEmails, ["ada@home.com", "lovelace@y.com"]);
    assert.equal(patch.phone, undefined);
    assert.deepEqual(patch.otherPhones, ["720-555-0000"]);
    assert.deepEqual(alsoAt, ["org3", "org2"]);
    assert.deepEqual(patch.tags, ["vip", "west"]);
    assert.equal(patch.marketingOptIn, false);
    assert.equal(patch.decisionMaker, true);
    assert.deepEqual(patch.textOptOutAt, day(5));
  });

  it("takes a main email, phone and organization from the others when the survivor has none", () => {
    const { patch, alsoAt } = planPersonMerge(person("a", 1, { phone: "303-555-0123" }), [person("b", 2, { email: "ada@x.com", emailBouncedAt: day(3), phone: "3035550123", organizationId: "org2" })]);
    assert.equal(patch.email, "ada@x.com");
    assert.deepEqual(patch.emailBouncedAt, day(3));
    assert.equal(patch.otherEmails, undefined);
    assert.equal(patch.otherPhones, undefined);
    assert.equal(patch.organizationId, "org2");
    assert.deepEqual(alsoAt, []);
  });

  it("changes nothing when merging a record into itself again", () => {
    const a = person("a", 1, { email: "ada@x.com", otherEmails: ["ada@home.com"], phone: "303-555-0123" });
    assert.deepEqual(planPersonMerge(a, [{ email: "ada@home.com", phone: "3035550123" }]).patch, {});
  });

  it("keeps replaced contacts when Pipedrive changes the main ones", () => {
    assert.deepEqual(keepContactsOnImport({ email: "old@x.com", phone: "303-555-0123", otherEmails: ["new@x.com"], otherPhones: [] }, { email: "new@x.com", phone: null }), {
      email: "new@x.com",
      phone: "303-555-0123",
      otherEmails: ["old@x.com"],
      otherPhones: [],
    });
    assert.deepEqual(distinct(["12", " 12 ", "(303) 555-0123", "3035550123"], phoneKey), ["12", "(303) 555-0123"]);
  });
});

describe("merging clients", () => {
  it("groups one organization's clients, using where merged organizations and people will point", () => {
    const rows = [client("a", 1), client("b", 2, { organizationId: "org1-dup" }), client("c", 3, { organizationId: "org2" }), client("d", 4, { organizationId: null, personId: "p1" }), client("e", 5, { organizationId: null, personId: "p1-dup" }), client("f", 6, { organizationId: null })];
    const merged = { "org1-dup": "org1", "p1-dup": "p1" } as Record<string, string>;
    const groups = groupClients(
      rows,
      (id) => merged[id] ?? id,
      (id) => merged[id] ?? id,
    );
    assert.deepEqual(
      groups.map((g) => g.map((r) => r.id)),
      [
        ["a", "b"],
        ["d", "e"],
      ],
    );
  });

  it("keeps the client that's furthest along, and fills its blanks from the same category", () => {
    const { survivor, donors } = pickClientSurvivor([
      client("old-prospect", 1, { value: 500_00, expectedCloseDate: "2024-06-01", tags: ["referral"] }),
      client("current", 2, { category: "current", startedOn: "2023-05-01" }),
      client("past", 3, { category: "past", startedOn: "2021-01-01", churnReason: "Price", health: "at_risk" as ClientFields["health"] }),
      client("archived-current", 0, { category: "current", archivedAt: day(9) }),
    ]);
    assert.equal(survivor.id, "current");
    assert.deepEqual(
      donors.map((d) => d.id),
      ["past", "old-prospect", "archived-current"],
    );
    assert.deepEqual(planClientMerge(survivor, donors), { startedOn: "2021-01-01", tags: ["referral"] });
  });

  it("keeps every product line any of them was on", () => {
    const survivor = client("a", 1, { productLines: ["VRA"] });
    assert.deepEqual(planClientMerge(survivor, [client("b", 2, { productLines: ["TalentScout", "VRA"] })]).productLines, ["TalentScout", "VRA"]);
    assert.equal(planClientMerge(survivor, [client("c", 2)]).productLines, undefined);
  });

  it("among prospects, keeps the one in the stage with the higher win probability", () => {
    const probability: Record<string, number> = { lead: 10, negotiation: 80 };
    const rows = [client("lead", 1), client("negotiation", 2)];
    assert.equal(pickClientSurvivor(rows, (c) => probability[c.id]).survivor.id, "negotiation");
    // Without probabilities, the oldest, as before.
    assert.equal(pickClientSurvivor(rows).survivor.id, "lead");
    // A current client still beats any prospect.
    assert.equal(pickClientSurvivor([...rows, client("current", 3, { category: "current" })], (c) => probability[c.id] ?? 0).survivor.id, "current");
  });
});
