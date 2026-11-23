import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { roleCan } from "@/lib/permissions";
import { toolOperations } from "@/lib/mcp/protocol";
import { markdownToHtml } from "./markdown";
import { allowedOperations } from "./policy";
import { budgetRefusal, formatUsd, mentionsAgent, monthStart, runFailure, runMayUse, runMessage, runTitle, usdToMicro } from "./run-rules";
import { signRunToken, verifyRunToken } from "./run-token";
import { enrichMayUse } from "./enrich-rules";

const caps = { monthlyBudgetUsd: 30, maxConcurrentPerUser: 3, maxRunUsd: 0.75, maxBulkRecords: 50 };

describe("background runs: what a run may do", () => {
  const memberTools = allowedOperations((p) => roleCan("member", p), { features: ["background"] });

  it("never archives, deletes or merges, and can't start more runs", () => {
    const run = memberTools.filter(runMayUse).map((o) => o.tool);
    for (const tool of ["archive_person", "archive_client", "delete_task", "delete_note", "merge_people", "merge_organizations", "start_background_task", "cancel_background_task", "list_background_tasks"]) {
      assert.ok(toolOperations.some((o) => o.tool === tool), `${tool} exists`);
      assert.ok(!run.includes(tool), `${tool} is not offered to a run`);
    }
    for (const tool of ["search", "create_person", "update_person", "create_note", "create_task", "update_organization"]) assert.ok(run.includes(tool), `${tool} is offered to a run`);
  });

  it("gives a viewer's run only reading tools", () => {
    const viewer = allowedOperations((p) => roleCan("viewer", p), { features: ["background"] }).filter(runMayUse);
    assert.ok(viewer.length > 0);
    assert.ok(viewer.every((o) => o.method === "GET"));
  });

  it("gives an enrichment run reading tools and its own record's update tool, nothing else that writes", () => {
    for (const entity of ["person", "organization"] as const) {
      const run = memberTools.filter(runMayUse).filter((o) => enrichMayUse(o, entity));
      const writes = run.filter((o) => o.method !== "GET").map((o) => o.tool);
      assert.deepEqual(writes, [entity === "person" ? "update_person" : "update_organization"]);
      assert.ok(run.some((o) => o.tool === "search"), "it can still search");
    }
  });

  it("offers background tools only where background work is set up", () => {
    assert.ok(!allowedOperations((p) => roleCan("member", p)).some((o) => o.tool === "start_background_task"));
    assert.ok(memberTools.some((o) => o.tool === "start_background_task"));
  });
});

describe("background runs: calling on the agent in a note", () => {
  it("answers to @Agent and to the deployment's own name, as a word", () => {
    assert.ok(mentionsAgent("@Agent find who runs this company"));
    assert.ok(mentionsAgent("Can you check this, @agent?"));
    assert.ok(mentionsAgent("(@Agent) please"));
    assert.ok(mentionsAgent("@Scout research them", "Scout"));
    assert.ok(mentionsAgent("@agent research them", "Scout"));
  });

  it("ignores email addresses, longer words and plain talk about it", () => {
    assert.ok(!mentionsAgent("Mail sam@assistant.example about it"));
    assert.ok(!mentionsAgent("ask the agent later"));
    assert.ok(!mentionsAgent("@assistants"));
    assert.ok(!mentionsAgent("@Scout", "Sc.out"));
    assert.ok(!mentionsAgent(""));
    assert.ok(!mentionsAgent(null));
  });

  it("lets a run write drafts but not send, archive or start runs", () => {
    const run = allowedOperations((p) => roleCan("member", p), { features: ["background"] }).filter(runMayUse).map((o) => o.tool);
    assert.ok(run.includes("draft_message"));
    assert.ok(!run.includes("start_bulk_background_task"));
    assert.ok(!toolOperations.some((o) => /^send_/.test(o.tool)), "no tool sends a message");
  });
});

describe("background runs: budget", () => {
  it("counts the month from its first moment in UTC", () => {
    assert.equal(monthStart(new Date("2026-11-18T17:00:00Z")).toISOString(), "2026-11-01T00:00:00.000Z");
  });

  it("refuses new work once the month's budget is spent", () => {
    assert.equal(budgetRefusal({ spentMicroUsd: usdToMicro(29.99), active: 0 }, 1, caps), null);
    assert.match(budgetRefusal({ spentMicroUsd: usdToMicro(30), active: 0 }, 1, caps)!, /this month's budget \(\$30\)/);
  });

  it("lets work queue up to the bulk cap plus what runs at once", () => {
    assert.equal(budgetRefusal({ spentMicroUsd: 0, active: 3 }, 50, caps), null);
    assert.match(budgetRefusal({ spentMicroUsd: 0, active: 4 }, 50, caps)!, /already have 4 background tasks/);
    assert.match(budgetRefusal({ spentMicroUsd: 0, active: 0 }, 60, caps)!, /50 is the most one request can cover/);
  });

  it("explains a run that ran out of budget or time", () => {
    assert.match(runFailure("SESSION_USAGE_LIMIT_REACHED: over", caps), /spending limit for one task \(\$0\.75\)/);
    assert.match(runFailure("timed out", caps), /took too long/);
    assert.match(runFailure(undefined, caps), /Something went wrong/);
    assert.equal(formatUsd(30), "$30");
    assert.equal(formatUsd(0.5), "$0.50");
  });
});

describe("background runs: the first message", () => {
  const base = {
    user: { id: "u1", name: "Sam Lee", email: "sam@example.com", role: "member" as const },
    canWrite: true,
    workspace: { name: "Acme", timezone: "America/Denver", currency: "USD" },
    now: new Date("2026-11-18T17:00:00Z"),
    prompt: "Research Globex and add its people.",
  };

  it("says who it's for, how they asked and where the answer goes", () => {
    const text = runMessage({ ...base, source: "chat" });
    assert.match(text, /working in the background for Sam Lee \(sam@example\.com\), a member at Acme/);
    assert.match(text, /"Sam Lee via Agent"/);
    assert.match(text, /posted back into their chat/);
    assert.ok(text.endsWith("## The request\nResearch Globex and add its people."));
  });

  it("names the record and the task for an assigned task", () => {
    const text = runMessage({ ...base, source: "task", record: { entity: "organization", id: "o1", name: "Globex" }, activity: { id: "a1", type: "task", subject: "Find the decision maker" } });
    assert.match(text, /about the organization "Globex" \(id o1\)/);
    assert.match(text, /The task has id a1 and is called "Find the decision maker"/);
    assert.match(text, /Don't complete or edit the task yourself/);
  });

  it("tells a viewer's run it can only read", () => {
    assert.match(runMessage({ ...base, canWrite: false, source: "chat" }), /read-only/);
  });

  it("names a run after the start of its request", () => {
    assert.equal(runTitle("  Research   Globex\nand more "), "Research Globex and more");
    assert.equal(runTitle("x".repeat(200)).length, 80);
    assert.equal(runTitle(""), "Background task");
  });
});

describe("background runs: tokens", () => {
  const claims = { userId: "u1", runId: "r1", origin: "https://crm.example.com" };

  it("round-trips for the audience it was signed for, and no other", async () => {
    const token = await signRunToken("crm", claims, 60);
    assert.deepEqual(await verifyRunToken("crm", token), claims);
    assert.equal(await verifyRunToken("eve", token), null);
    assert.equal(await verifyRunToken("report", token), null);
  });

  it("refuses expired, altered and missing tokens", async () => {
    assert.equal(await verifyRunToken("crm", await signRunToken("crm", claims, -10)), null);
    const token = await signRunToken("crm", claims, 60);
    assert.equal(await verifyRunToken("crm", `${token.slice(0, -2)}xx`), null);
    assert.equal(await verifyRunToken("crm", null), null);
    assert.equal(await verifyRunToken("crm", "not-a-token"), null);
  });
});

describe("background runs: answers as notes", () => {
  it("turns markdown into the simple HTML notes store", () => {
    assert.equal(markdownToHtml("Added **two** people.\n\n- [Sam Lee](/people/p1), CEO\n- Jo *Park*\n\n1. First\n2. Second"), '<p>Added <strong>two</strong> people.</p><ul><li><a href="/people/p1">Sam Lee</a>, CEO</li><li>Jo <em>Park</em></li></ul><ol><li>First</li><li>Second</li></ol>');
    assert.equal(markdownToHtml("## What I did\nLine one\nLine two"), "<p><strong>What I did</strong></p><p>Line one<br>Line two</p>");
  });

  it("escapes markup and drops links that aren't web, mail or this site", () => {
    assert.equal(markdownToHtml('<script>alert(1)</script> [x](javascript:alert(1)) [y](//evil.example)'), "<p>&lt;script&gt;alert(1)&lt;/script&gt; x) y</p>");
    assert.equal(markdownToHtml("[site](https://acme.example/a?b=1)"), '<p><a href="https://acme.example/a?b=1">site</a></p>');
  });
});
