import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { ActionError, ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { roleCan, rolePermissions } from "@/lib/permissions";
import { readBodyLimited } from "./body";
import { curlFor, exampleBody, fieldsOf, typeLabel } from "./docs";
import { toApiError } from "./errors";
import { displayPrefix, generateKey, hashKey, keyFromHeaders, keyKind } from "./key-format";
import { models } from "./models";
import { buildOpenApi } from "./openapi";
import { operationList, operations, tags } from "./operations";
import { matchRoute } from "./router";

describe("roles", () => {
  it("lets viewers read and nothing else", () => {
    assert.deepEqual(rolePermissions("viewer"), ["records:read"]);
    assert.equal(roleCan("viewer", "records:write"), false);
  });
  it("lets members work records but not moderate or administer", () => {
    assert.equal(roleCan("member", "records:write"), true);
    assert.equal(roleCan("member", "records:archive"), true);
    assert.equal(roleCan("member", "activities:moderate"), false);
    assert.equal(roleCan("member", "workspace:admin"), false);
  });
  it("gives owners and admins everything", () => {
    for (const r of ["owner", "admin"] as const) assert.equal(roleCan(r, "workspace:admin"), true);
  });
});

describe("API keys", () => {
  it("generates keys with a kind prefix and stores only a hash", () => {
    const k = generateKey("personal");
    assert.match(k.token, /^crm_pk_[A-Za-z0-9_-]{43}$/);
    assert.equal(k.prefix, k.token.slice(0, 12));
    assert.equal(k.hash, hashKey(k.token));
    assert.match(k.hash, /^[0-9a-f]{64}$/);
    assert.notEqual(generateKey("personal").token, k.token);
    assert.match(generateKey("workspace").token, /^crm_ws_/);
  });
  it("recognizes only well-formed keys", () => {
    assert.equal(keyKind(generateKey("workspace").token), "workspace");
    assert.equal(keyKind(generateKey("personal").token), "personal");
    for (const bad of ["", "crm_pk_short", "crm_xx_" + "a".repeat(43), "Bearer crm_pk_" + "a".repeat(43)]) assert.equal(keyKind(bad), null);
  });
  it("reads the key from Authorization or X-API-Key", () => {
    assert.equal(keyFromHeaders(new Headers({ authorization: "Bearer abc" })), "abc");
    assert.equal(keyFromHeaders(new Headers({ authorization: "bearer   abc  " })), "abc");
    assert.equal(keyFromHeaders(new Headers({ authorization: "Basic abc" })), null);
    assert.equal(keyFromHeaders(new Headers({ "x-api-key": " abc " })), "abc");
    assert.equal(keyFromHeaders(new Headers()), null);
  });
  it("never shows enough of a key to use it", () => {
    assert.equal(displayPrefix("crm_pk_abcdefghijk").length, 12);
  });
});

describe("router", () => {
  const id = "3f6c2b1e-0000-4000-8000-000000000000";
  it("matches collections, records and sub-resources", () => {
    assert.deepEqual(matchRoute("GET", ["people"]), { ok: true, id: "listPeople", params: {} });
    assert.deepEqual(matchRoute("GET", ["people", id]), { ok: true, id: "getPerson", params: { id } });
    assert.deepEqual(matchRoute("POST", ["people", id, "restore"]), { ok: true, id: "restorePerson", params: { id } });
    assert.deepEqual(matchRoute("DELETE", ["clients", id, "metrics", "x"]), { ok: true, id: "deleteClientMetric", params: { id, metricId: "x" } });
    // A client's services come from Stripe now: the old sub-resource is gone.
    assert.deepEqual(matchRoute("PATCH", ["clients", id, "services", "x"]), { ok: false, status: 404 });
  });
  it("answers 405 with the allowed methods, and 404 for unknown paths", () => {
    const m = matchRoute("PUT", ["people", id]);
    assert.equal(m.ok, false);
    assert.equal(!m.ok && m.status, 405);
    assert.deepEqual(!m.ok && m.status === 405 ? m.allow.sort() : [], ["DELETE", "GET", "PATCH"]);
    assert.deepEqual(matchRoute("GET", ["nope"]), { ok: false, status: 404 });
    assert.deepEqual(matchRoute("GET", []), { ok: false, status: 404 });
  });
});

describe("operations", () => {
  it("have unique method and path pairs and unique MCP tool names", () => {
    const routes = operationList.map((o) => `${o.method} ${o.path}`);
    assert.equal(new Set(routes).size, routes.length);
    const tools = operationList.flatMap((o) => (o.tool ? [o.tool] : []));
    assert.equal(new Set(tools).size, tools.length);
    for (const t of tools) assert.match(t, /^[a-z][a-z_]*$/);
  });
  it("declare exactly the path parameters their path has", () => {
    for (const o of operationList) {
      const inPath = [...o.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const declared = Object.keys(o.params?.shape ?? {}).sort();
      assert.deepEqual(declared, inPath, `${o.id}: ${o.path}`);
    }
  });
  it("only take bodies on POST and PATCH, and only need read access for GET", () => {
    for (const o of operationList) {
      if (o.body) assert.ok(o.method === "POST" || o.method === "PATCH", o.id);
      if (o.method === "GET") assert.equal(o.permission, "records:read", o.id);
      else assert.notEqual(o.permission, "records:read", o.id);
    }
  });
  it("use known tags and models", () => {
    const tagNames = new Set<string>(tags.map((t) => t.name));
    for (const o of operationList) {
      assert.ok(tagNames.has(o.tag), `${o.id} tag ${o.tag}`);
      assert.ok(o.response in models, `${o.id} response ${o.response}`);
    }
  });
  it("accept query strings for booleans and numbers", () => {
    const q = operations.listPeople.query!.parse({ includeArchived: "true", limit: "5" });
    assert.equal(q.includeArchived, true);
    assert.equal(q.limit, 5);
    assert.throws(() => operations.listPeople.query!.parse({ limit: "500" }));
  });
  it("validate their examples", () => {
    for (const o of operationList) if (o.example && o.body) assert.ok(o.body.safeParse(o.example).success || JSON.stringify(o.example).includes("…"), o.id);
  });
});

describe("OpenAPI", () => {
  const doc = buildOpenApi({ title: "CRM API", serverUrl: "https://crm.example.com/api/v1" });
  it("describes every operation once", () => {
    const count = Object.values(doc.paths).reduce((n, methods) => n + Object.keys(methods).length, 0);
    assert.equal(count, operationList.length);
    assert.equal(doc.paths["/people/{id}"].patch.operationId, "updatePerson");
  });
  it("references only models it defines", () => {
    const refs = [...JSON.stringify(doc).matchAll(/#\/components\/schemas\/(\w+)/g)].map((m) => m[1]);
    for (const r of refs) assert.ok(r in doc.components.schemas, r);
  });
  it("leaves out the long regexes zod adds next to formats", () => {
    assert.doesNotMatch(JSON.stringify(doc), /"pattern":"\^\(\[0-9a-fA-F\]\{8\}/);
  });
});

describe("docs helpers", () => {
  it("labels types readably", () => {
    assert.equal(typeLabel({ anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] }), "string (uuid) or null");
    assert.equal(typeLabel({ enum: ["a", "b"] }), '"a" | "b"');
    assert.equal(typeLabel({ type: "array", items: { type: "string" } }), "string[]");
  });
  it("lists body fields with what's required", () => {
    const f = fieldsOf(operations.createPerson.body);
    assert.deepEqual(f.find((x) => x.name === "firstName")?.required, true);
    assert.deepEqual(f.find((x) => x.name === "email")?.required, false);
  });
  it("builds curl examples with placeholders", () => {
    const c = curlFor(operations.deleteClientMetric);
    assert.match(c, /-X DELETE "\$CRM_URL\/api\/v1\/clients\/\$ID\/metrics\/\$METRIC_ID"/);
    assert.match(curlFor(operations.updatePerson), /-X PATCH "\$CRM_URL\/api\/v1\/people\/\$ID"/);
    assert.ok(exampleBody(operations.createTask));
  });
});

describe("errors", () => {
  it("map to status codes with readable messages", () => {
    assert.equal(toApiError(new NotFoundError("Gone."))?.status, 404);
    assert.equal(toApiError(new ForbiddenError("No."))?.status, 403);
    assert.deepEqual(toApiError(new ConflictError("Exists.", { cause: { id: "x" } })), { status: 409, code: "conflict", message: "Exists.", existingId: "x" });
    assert.equal(toApiError(new ActionError("Bad."))?.status, 400);
    assert.equal(toApiError(new Error("internal")), null);
  });
  it("report every validation issue with its field", () => {
    const r = z.object({ a: z.string(), b: z.number() }).safeParse({});
    const e = toApiError(r.error);
    assert.equal(e?.status, 422);
    assert.deepEqual(
      e?.issues?.map((i) => i.path),
      ["a", "b"],
    );
    assert.match(e!.message, /^a: /);
  });
});

describe("request bodies", () => {
  const stream = (chunks: string[]) =>
    new Request("https://crm.example.com/x", {
      method: "POST",
      body: new ReadableStream({
        start(c) {
          for (const x of chunks) c.enqueue(new TextEncoder().encode(x));
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
  it("reads bodies under the limit", async () => {
    assert.deepEqual(await readBodyLimited(stream(["{\"a\":", "1}"]), 100), { ok: true, text: '{"a":1}' });
  });
  it("stops at the limit in bytes, without a Content-Length", async () => {
    assert.deepEqual(await readBodyLimited(stream(["é".repeat(30), "é".repeat(30)]), 100), { ok: false });
  });
  it("trusts a Content-Length that's already too big", async () => {
    const r = new Request("https://crm.example.com/x", { method: "POST", body: "x", headers: { "content-length": "999999999" } });
    assert.deepEqual(await readBodyLimited(r, 100), { ok: false });
  });
});
