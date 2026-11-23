import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_RUN_PROMPT } from "./run-rules";
import { ENRICH_NOTE_SUBJECT, enrichMayUse, enrichPrompt, enrichWriteProblem, type EnrichField } from "./enrich-rules";

describe("enrichPrompt", () => {
  const person = enrichPrompt({
    entity: "person",
    id: "p1",
    name: "Jo Park",
    context: ["Name: Jo Park", "Organization: Acme (acme.com)"],
    fields: [
      { label: "Email", field: "email", value: "jo@acme.com" },
      { label: "Job title", field: "title", value: null },
      { label: "Seniority", field: "custom.seniority", value: "", type: "select", options: ["Junior", "Senior"] },
    ],
  });

  it("says what's there now and what's empty", () => {
    assert.match(person, /- Email \(`email`\): jo@acme\.com/);
    assert.match(person, /- Job title \(`title`\): \(empty\)/);
    assert.match(person, /- Seniority \(`custom\.seniority` \[select: one of Junior, Senior\]\): \(empty\)/);
    assert.match(person, /Organization: Acme \(acme\.com\)/);
  });

  it("fills only blanks it's sure of, through the record's own update tool", () => {
    assert.match(person, /crm__update_person/);
    assert.doesNotMatch(person, /crm__update_organization/);
    assert.match(person, /Never replace a value that's already there/);
    assert.match(person, /Don't guess an email address/);
  });

  it("lays the note out as filled in, not sure and sources", () => {
    for (const heading of ["**Filled in**", "**Not sure**", "**Sources**"]) assert.ok(person.includes(heading), heading);
    assert.ok(person.includes(ENRICH_NOTE_SUBJECT));
  });

  it("keeps an organization to its own fields", () => {
    const org = enrichPrompt({ entity: "organization", id: "o1", name: "Acme", context: ["Name: Acme"], fields: [{ label: "Website", field: "domain", value: null }] });
    assert.match(org, /crm__update_organization/);
    assert.match(org, /parent organization or its people/);
  });

  it("keeps its instructions and stays within a run's request limit, however much the record holds", () => {
    const long = enrichPrompt({ entity: "organization", id: "o1", name: "Acme", context: [], fields: Array.from({ length: 30 }, (_, i) => ({ label: `Field ${i}`, field: `custom.f${i}`, value: "x".repeat(2000) })) });
    assert.ok(long.length <= MAX_RUN_PROMPT, `${long.length}`);
    assert.match(long, /\*\*Sources\*\*/);
    assert.match(long, /- Field 0 \(`custom\.f0`\): x{200}…/);
  });
});

describe("enrichMayUse", () => {
  it("lets an enrichment run read, and update only its own kind of record", () => {
    assert.equal(enrichMayUse({ method: "GET", tool: "search" }, "person"), true);
    assert.equal(enrichMayUse({ method: "PATCH", tool: "update_person" }, "person"), true);
    assert.equal(enrichMayUse({ method: "PATCH", tool: "update_organization" }, "person"), false);
    assert.equal(enrichMayUse({ method: "PATCH", tool: "update_organization" }, "organization"), true);
    for (const tool of ["create_task", "create_note", "update_client", "create_person", "log_activity", "draft_message", "upload_file"]) {
      assert.equal(enrichMayUse({ method: "POST", tool }, "person"), false, tool);
    }
  });
});

describe("enrichWriteProblem", () => {
  const scope = { entity: "person" as const, id: "p1" };
  const fields: EnrichField[] = [
    { label: "Email", field: "email", value: "jo@acme.com" },
    { label: "Phone", field: "phone", value: null },
    { label: "Job title", field: "title", value: "" },
    { label: "Seniority", field: "custom.seniority", value: undefined },
    { label: "Region", field: "custom.region", value: "West" },
  ];
  const at = (id: unknown, entity: "person" | "organization" = "person") => ({ entity, id });

  it("allows filling empty offered fields on the record being enriched", () => {
    assert.equal(enrichWriteProblem(scope, at("p1"), { phone: "555-0100", title: "Broker", custom: { seniority: "Senior" } }, fields), null);
    const upper = { entity: "person" as const, id: "0f8fad5b-d9cb-469f-a165-70867728950e" };
    assert.equal(enrichWriteProblem(upper, at(upper.id.toUpperCase()), { phone: "555-0100" }, fields), null);
  });

  it("refuses another record, another kind of record, or a record that's gone", () => {
    assert.match(enrichWriteProblem(scope, at("p2"), { phone: "555-0100" }, fields)!, /only fills in the person it was started on/);
    assert.match(enrichWriteProblem(scope, at("p1", "organization"), { phone: "555-0100" }, fields)!, /started on/);
    assert.match(enrichWriteProblem({ entity: "person", id: null }, at("p1"), { phone: "555-0100" }, fields)!, /started on/);
  });

  it("refuses fields it wasn't offered, such as the owner, labels or name", () => {
    assert.match(enrichWriteProblem(scope, at("p1"), { ownerId: "u2" }, fields)!, /Leave ownerId/);
    assert.match(enrichWriteProblem(scope, at("p1"), { phone: "555-0100", tags: ["vip"] }, fields)!, /Leave tags/);
    assert.match(enrichWriteProblem(scope, at("p1"), { custom: { budget: 5 } }, fields)!, /Leave custom.budget/);
  });

  it("never replaces a value that's already there", () => {
    assert.match(enrichWriteProblem(scope, at("p1"), { email: "other@acme.com" }, fields)!, /email already has a value/);
    assert.match(enrichWriteProblem(scope, at("p1"), { custom: { region: "East" } }, fields)!, /custom.region already has a value/);
  });
});
