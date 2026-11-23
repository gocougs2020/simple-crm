import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { operations } from "@/lib/api/operations";
import { roleCan } from "@/lib/permissions";
import { handleMessage, LATEST_VERSION, RpcError, splitArguments, toolInputSchema, toolsFor, type McpServer } from "./protocol";

const calls: { name: string; args: Record<string, unknown> }[] = [];
const server = (role: "owner" | "viewer"): McpServer => ({
  info: { name: "crm", title: "CRM", version: "1.0.0" },
  instructions: "Hello.",
  tools: toolsFor((p) => roleCan(role, p)),
  async callTool(name, args) {
    calls.push({ name, args });
    return { content: [{ type: "text", text: "ok" }] };
  },
});

const rpc = (method: string, params?: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) });
const notify = (method: string) => ({ jsonrpc: "2.0", method });

describe("MCP protocol", () => {
  it("negotiates the protocol version", async () => {
    const r = (await handleMessage(server("owner"), rpc("initialize", { protocolVersion: "2025-06-18" }))) as { result: { protocolVersion: string; capabilities: unknown; instructions: string } };
    assert.equal(r.result.protocolVersion, "2025-06-18");
    assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
    assert.equal(r.result.instructions, "Hello.");
    const old = (await handleMessage(server("owner"), rpc("initialize", { protocolVersion: "1999-01-01" }))) as { result: { protocolVersion: string } };
    assert.equal(old.result.protocolVersion, LATEST_VERSION);
  });

  it("doesn't answer notifications or responses", async () => {
    assert.equal(await handleMessage(server("owner"), notify("notifications/initialized")), null);
    assert.equal(await handleMessage(server("owner"), { jsonrpc: "2.0", id: 4, result: {} }), null);
  });

  it("rejects malformed messages and unknown methods", async () => {
    const bad = (await handleMessage(server("owner"), { hello: "world" })) as { error: { code: number } };
    assert.equal(bad.error.code, RpcError.invalidRequest);
    const unknown = (await handleMessage(server("owner"), rpc("sampling/createMessage"))) as { error: { code: number } };
    assert.equal(unknown.error.code, RpcError.methodNotFound);
    assert.deepEqual(await handleMessage(server("owner"), rpc("ping")), { jsonrpc: "2.0", id: 1, result: {} });
  });

  it("gives a read-only teammate only reading tools", async () => {
    const owner = server("owner").tools.map((t) => t.name);
    const viewer = server("viewer").tools;
    assert.ok(owner.includes("create_task"));
    assert.ok(viewer.length > 5 && viewer.length < owner.length);
    for (const t of viewer) assert.equal(t.annotations.readOnlyHint, true, t.name);
    const refused = (await handleMessage(server("viewer"), rpc("tools/call", { name: "create_task", arguments: {} }))) as { error: { code: number } };
    assert.equal(refused.error.code, RpcError.invalidParams);
  });

  it("marks deletes as destructive", () => {
    const del = server("owner").tools.find((t) => t.name === "delete_task")!;
    assert.equal(del.annotations.destructiveHint, true);
    assert.equal(del.annotations.readOnlyHint, false);
  });

  it("calls tools with their arguments", async () => {
    calls.length = 0;
    const r = (await handleMessage(server("owner"), rpc("tools/call", { name: "get_person", arguments: { id: "x" } }))) as { result: unknown };
    assert.deepEqual(r.result, { content: [{ type: "text", text: "ok" }] });
    assert.deepEqual(calls, [{ name: "get_person", args: { id: "x" } }]);
  });
});

describe("MCP tools from operations", () => {
  it("merge path, query and body into one input schema", () => {
    const s = toolInputSchema(operations.updatePerson) as { properties: Record<string, unknown>; required?: string[]; additionalProperties: boolean };
    assert.ok("id" in s.properties && "firstName" in s.properties);
    assert.deepEqual(s.required, ["id"]);
    assert.equal(s.additionalProperties, false);
  });

  it("split arguments back into params, query and body", () => {
    const split = splitArguments(operations.updatePerson, { id: "p", firstName: "Sam", junk: 1 });
    assert.deepEqual(split, { params: { id: "p" }, query: undefined, body: { firstName: "Sam" } });
    assert.deepEqual(splitArguments(operations.deleteClientMetric, { id: "c", metricId: "m" }).params, { id: "c", metricId: "m" });
    assert.deepEqual(splitArguments(operations.listPeople, { q: "sam", limit: 5 }).query, { q: "sam", limit: 5 });
  });
});
