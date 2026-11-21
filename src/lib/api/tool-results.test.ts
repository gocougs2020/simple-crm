import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { TOOL_LIST_LIMIT, toolArguments, toolResult } from "./tool-results";

describe("tool results", () => {
  it("leaves out HTML bodies that have a plain-text copy, at any depth", () => {
    const note = { id: "a", body: "<p>Hi <b>Sam</b></p>", bodyText: "Hi Sam", replies: [{ id: "r", body: "<p>Ok</p>", bodyText: "Ok" }] };
    assert.deepEqual(toolResult({ data: [note] }), { data: [{ id: "a", bodyText: "Hi Sam", replies: [{ id: "r", bodyText: "Ok" }] }] });
  });

  it("keeps a body with no plain-text copy", () => {
    assert.deepEqual(toolResult({ body: "<p>x</p>", bodyText: null }), { body: "<p>x</p>", bodyText: null });
    assert.deepEqual(toolResult({ body: "plain" }), { body: "plain" });
  });

  it("asks list tools for fewer rows by default, and keeps an explicit limit", () => {
    const op = { query: z.object({ limit: z.number().optional(), q: z.string().optional() }) };
    assert.deepEqual(toolArguments(op, { q: "sam" }), { q: "sam", limit: TOOL_LIST_LIMIT });
    assert.deepEqual(toolArguments(op, { limit: 50 }), { limit: 50 });
    assert.deepEqual(toolArguments({ query: z.object({ q: z.string() }) }, { q: "x" }), { q: "x" });
    assert.deepEqual(toolArguments({}, { id: "x" }), { id: "x" });
  });
});
