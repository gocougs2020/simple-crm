import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_RUN_PROMPT } from "./run-rules";
import { ENRICH_NOTE_SUBJECT, enrichPrompt } from "./enrich-rules";

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
