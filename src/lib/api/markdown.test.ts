import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { codeSpans } from "./integrations";
import { buildMarkdown } from "./markdown";
import { operationList, operations } from "./operations";

describe("the Markdown reference", () => {
  const md = buildMarkdown({ name: "Acme CRM", origin: "https://crm.example.com/" });

  it("documents every endpoint, with its full path", () => {
    for (const op of operationList) assert.ok(md.includes(`\`${op.method} https://crm.example.com/api/v1${op.path}\``), `${op.method} ${op.path} is missing`);
  });

  it("explains authorization and the Zapier guide", () => {
    for (const s of ["## Authorization", "Authorization: Bearer", "crm_ws_", "crm_pk_", "OAuth 2.1", "## Connect Zapier, Make and other tools", "?ifExists=return"]) assert.ok(md.includes(s), s);
  });

  it("fills in the site's address and leaves no placeholder", () => {
    // Only the quick start, right after it exports CRM_URL.
    assert.equal(md.split("$CRM_URL").length - 1, 1);
    assert.ok(!md.includes("example.com//"));
  });

  it("keeps table rows on one line", () => {
    for (const line of md.split("\n").filter((l) => l.startsWith("| "))) assert.ok(line.trimEnd().endsWith("|"), line);
  });
});

describe("find-or-create", () => {
  it("is offered on creating people and organizations", () => {
    for (const op of [operations.createPerson, operations.createOrganization]) {
      assert.deepEqual(op.query!.parse({ ifExists: "return" }), { ifExists: "return" });
      assert.throws(() => op.query!.parse({ ifExists: "update" }));
    }
  });
});

describe("guide code spans", () => {
  it("splits backticked text out", () => {
    assert.deepEqual(codeSpans("Use `POST` now"), [
      { code: false, text: "Use " },
      { code: true, text: "POST" },
      { code: false, text: " now" },
    ]);
  });
});
