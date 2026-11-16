import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiFailure } from "@/lib/api/errors";
import { operations } from "@/lib/api/operations";
import { allowedOperations } from "@/lib/agent/policy";
import { agentInstructions } from "@/lib/agent/prompt";
import { toolsFor } from "@/lib/mcp/protocol";
import { roleCan } from "@/lib/permissions";
import { KNOWLEDGE_TOOL, knowledgeFailure, knowledgeInstructions, knowledgeToolDescription, knowledgeUrl, parseKnowledgeEnv, readKnowledge, upstreamMessage, type KnowledgeSource } from "./core";

const source = (over: Partial<KnowledgeSource> = {}): KnowledgeSource => {
  const parsed = parseKnowledgeEnv({ KNOWLEDGE_API_URL: "https://example.com/api/content", KNOWLEDGE_API_KEY: "secret-key" });
  assert.ok(parsed && !("error" in parsed));
  return { ...parsed, ...over };
};
const href = (path: string) => knowledgeUrl(source().base, path)?.href ?? null;

describe("knowledge source config", () => {
  it("is off until a URL is set", () => {
    assert.equal(parseKnowledgeEnv({}), null);
    assert.equal(parseKnowledgeEnv({ KNOWLEDGE_API_URL: "  ", KNOWLEDGE_API_KEY: "k" }), null);
  });

  it("reads the base, key, name and description", () => {
    const s = parseKnowledgeEnv({ KNOWLEDGE_API_URL: "https://www.example.com/api/content/", KNOWLEDGE_API_KEY: " k1 ", KNOWLEDGE_DESCRIPTION: "  Posts\n and pages. " });
    assert.ok(s && !("error" in s));
    assert.equal(s.base.href, "https://www.example.com/api/content");
    assert.deepEqual(s.auth, { header: "Authorization", value: "Bearer k1" });
    assert.equal(s.name, "example.com");
    assert.equal(s.description, "Posts and pages.");
    const named = parseKnowledgeEnv({ KNOWLEDGE_API_URL: "https://example.com", KNOWLEDGE_NAME: "Acme website" });
    assert.ok(named && !("error" in named));
    assert.equal(named.name, "Acme website");
    assert.equal(named.auth, null);
  });

  it("sends the key in another header when asked", () => {
    const s = parseKnowledgeEnv({ KNOWLEDGE_API_URL: "https://example.com/api", KNOWLEDGE_API_KEY: "k", KNOWLEDGE_API_KEY_HEADER: "X-API-Key" });
    assert.ok(s && !("error" in s));
    assert.deepEqual(s.auth, { header: "X-API-Key", value: "k" });
    assert.ok("error" in (parseKnowledgeEnv({ KNOWLEDGE_API_URL: "https://example.com", KNOWLEDGE_API_KEY_HEADER: "X-Key: evil" }) as object));
  });

  it("refuses insecure or ambiguous URLs with a reason", () => {
    for (const bad of ["not a url", "http://example.com/api", "ftp://example.com", "https://user:pw@example.com/api", "https://example.com/api?key=1", "https://example.com/api#x"]) {
      const r = parseKnowledgeEnv({ KNOWLEDGE_API_URL: bad });
      assert.ok(r && "error" in r, bad);
    }
    const local = parseKnowledgeEnv({ KNOWLEDGE_API_URL: "http://localhost:4000/api" });
    assert.ok(local && !("error" in local));
  });
});

describe("knowledge paths", () => {
  it("stays under the base and drops trailing slashes", () => {
    assert.equal(href("/"), "https://example.com/api/content");
    assert.equal(href(""), "https://example.com/api/content");
    assert.equal(href("posts"), "https://example.com/api/content/posts");
    assert.equal(href("/posts/"), "https://example.com/api/content/posts");
    assert.equal(href("/search?q=keeping new agents&limit=5"), "https://example.com/api/content/search?q=keeping%20new%20agents&limit=5");
    assert.equal(href("?fields=summary"), "https://example.com/api/content?fields=summary");
  });

  it("accepts the base path repeated, or a full URL under the base", () => {
    assert.equal(href("/api/content/pages?path=/corecruit"), "https://example.com/api/content/pages?path=/corecruit");
    assert.equal(href("https://example.com/api/content/site"), "https://example.com/api/content/site");
    assert.equal(href("https://example.com/api/content"), "https://example.com/api/content");
  });

  it("refuses anything that could leave the base", () => {
    for (const bad of [
      "/../crm/contacts",
      "/posts/../../crm",
      "/%2e%2e/crm",
      "/posts%2F..%2F..%2Fcrm",
      "/posts\\..\\crm",
      "//evil.com/x",
      "https://evil.com/api/content/posts",
      "https://example.com/api/contentx",
      "https://example.com/api/crm/contacts",
      "http://example.com/api/content/posts",
      "/posts/.",
      "/a b",
      "x".repeat(2001),
    ]) {
      assert.equal(href(bad), null, bad);
    }
  });

  it("works for a source at the root of a site", () => {
    const root = parseKnowledgeEnv({ KNOWLEDGE_API_URL: "https://example.com" });
    assert.ok(root && !("error" in root));
    assert.equal(knowledgeUrl(root.base, "/posts")?.href, "https://example.com/posts");
    assert.equal(knowledgeUrl(root.base, "/")?.href, "https://example.com/");
  });
});

describe("knowledge errors", () => {
  it("reads the upstream's message in its common shapes", () => {
    assert.equal(upstreamMessage({ error: "phone: Enter a 10-digit phone number" }), "phone: Enter a 10-digit phone number");
    assert.equal(upstreamMessage({ error: { message: "Bad\n  topic" } }), "Bad topic");
    assert.equal(upstreamMessage({ message: "Nope" }), "Nope");
    assert.equal(upstreamMessage("text"), null);
  });

  it("says what each status means and never blames the caller for the key", () => {
    assert.equal(knowledgeFailure("Acme", "/x", 400, { error: "limit: too big" }).status, 400);
    assert.match(knowledgeFailure("Acme", "/x", 400, { error: "limit: too big" }).message, /limit: too big/);
    assert.equal(knowledgeFailure("Acme", "/x", 404, null).status, 404);
    const auth = knowledgeFailure("Acme", "/x", 401, { error: "Send Authorization: Bearer <API key>." });
    assert.equal(auth.status, 502);
    assert.match(auth.message, /KNOWLEDGE_API_KEY/);
    assert.equal(knowledgeFailure("Acme", "/x", 429, null).status, 503);
    assert.equal(knowledgeFailure("Acme", "/x", 503, null).code, "knowledge_unavailable");
    assert.equal(knowledgeFailure("Acme", "/x", 308, null).code, "knowledge_redirect");
    assert.equal(knowledgeFailure("Acme", "/x", 500, null).status, 502);
  });
});

describe("reading the knowledge source", () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fake =
    (status: number, body: string, type = "application/json"): typeof fetch =>
    async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(body, { status, headers: { "content-type": type } });
    };

  it("sends the key, refuses redirects, and returns the JSON", async () => {
    calls.length = 0;
    const r = await readKnowledge(source(), "/search?q=retention", fake(200, JSON.stringify({ posts: [{ title: "Retention starts on day one" }] })));
    assert.deepEqual(r, { source: "example.com", path: "/search?q=retention", url: "https://example.com/api/content/search?q=retention", content: { posts: [{ title: "Retention starts on day one" }] } });
    assert.equal(calls[0].url, "https://example.com/api/content/search?q=retention");
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer secret-key");
    assert.equal(calls[0].init.redirect, "manual");
    assert.ok(!JSON.stringify(r).includes("secret-key"));
  });

  it("passes text through", async () => {
    const r = await readKnowledge(source(), "/robots", fake(200, "hello", "text/plain"));
    assert.equal(r.content, "hello");
  });

  it("never fetches a path outside the base", async () => {
    calls.length = 0;
    await assert.rejects(readKnowledge(source(), "/../crm/contacts", fake(200, "{}")), (e: unknown) => e instanceof ApiFailure && e.error.status === 400);
    assert.equal(calls.length, 0);
  });

  it("turns upstream failures into sentences, without the key", async () => {
    await assert.rejects(readKnowledge(source(), "/nope", fake(404, JSON.stringify({ error: "No record with that id or slug" }))), (e: unknown) => e instanceof ApiFailure && e.error.status === 404 && /No record/.test(e.error.message));
    await assert.rejects(readKnowledge(source(), "/", fake(401, "{}")), (e: unknown) => e instanceof ApiFailure && e.error.code === "knowledge_unauthorized" && !e.error.message.includes("secret-key"));
    const offline: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await assert.rejects(readKnowledge(source(), "/", offline), (e: unknown) => e instanceof ApiFailure && e.error.status === 502);
  });

  it("refuses answers over 2 MB", async () => {
    await assert.rejects(readKnowledge(source(), "/posts", fake(200, "x".repeat(2 * 1024 * 1024 + 1))), (e: unknown) => e instanceof ApiFailure && e.error.code === "knowledge_too_large");
  });
});

describe("knowledge tool", () => {
  const viewer = (p: Parameters<typeof roleCan>[1]) => roleCan("viewer", p);

  it("is an MCP and assistant tool only where a source is connected", () => {
    assert.equal(operations.getKnowledge.tool, KNOWLEDGE_TOOL);
    assert.ok(!toolsFor(viewer).some((t) => t.name === KNOWLEDGE_TOOL));
    const tool = toolsFor(viewer, ["knowledge"]).find((t) => t.name === KNOWLEDGE_TOOL);
    assert.ok(tool);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.ok(!allowedOperations(viewer).some((o) => o.tool === KNOWLEDGE_TOOL));
    assert.ok(allowedOperations(viewer, { voice: true, features: ["knowledge"] }).some((o) => o.tool === KNOWLEDGE_TOOL));
  });

  it("names and describes the deployment's source for agents", () => {
    const s = { name: "Acme website", description: "Services, team and blog posts." };
    assert.match(knowledgeToolDescription("Look things up.", s), /^Look things up\. Connected source: Acme website\. Services, team and blog posts\.$/);
    assert.match(knowledgeInstructions(s), /get_knowledge reads Acme website/);
  });

  it("tells the assistant about the source only when one is connected", () => {
    const base = { user: { id: "u1", name: "Sam", email: "sam@example.com", role: "owner" as const }, canWrite: true, workspace: { name: "Acme", timezone: "UTC", currency: "USD" }, now: new Date("2026-11-16T12:00:00Z") };
    assert.doesNotMatch(agentInstructions(base), /get_knowledge/);
    const text = agentInstructions({ ...base, knowledge: knowledgeInstructions({ name: "Acme website", description: null }) });
    assert.match(text, /## About Acme\nget_knowledge reads Acme website/);
  });
});
