import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runBatch } from "./batch-core";

// Stand-ins for query builders: thenables that record when they run.
const statement = (log: string[], name: string) => ({ then: (ok: (v: unknown) => void) => ok(log.push(name)) }) as never;

describe("runBatch", () => {
  it("sends everything as one batch where the driver can", async () => {
    const sent: unknown[][] = [];
    const db = { batch: async (items: readonly unknown[]) => void sent.push([...items]), transaction: async () => assert.fail("no transaction") } as never;
    await runBatch(db, () => ["update", "history"] as never);
    assert.deepEqual(sent, [["update", "history"]]);
  });

  it("sends nothing when there's nothing to write", async () => {
    let calls = 0;
    const db = { batch: async () => void calls++, transaction: async () => assert.fail("no transaction") } as never;
    await runBatch(db, () => []);
    assert.equal(calls, 0);
  });

  it("runs the statements in order inside one transaction otherwise, built on the transaction", async () => {
    const log: string[] = [];
    const tx = { name: "tx" };
    let handed: unknown;
    const db = { transaction: async (fn: (t: unknown) => Promise<unknown>) => { log.push("begin"); await fn(tx); log.push("commit"); } } as never;
    await runBatch(db, (d) => {
      handed = d;
      return [statement(log, "update"), statement(log, "history")];
    });
    assert.equal(handed, tx);
    assert.deepEqual(log, ["begin", "update", "history", "commit"]);
  });

  it("stops at the first failure, so the transaction rolls back", async () => {
    const log: string[] = [];
    const failing = { then: (_ok: unknown, fail: (e: Error) => void) => fail(new Error("boom")) } as never;
    const db = { transaction: async (fn: (t: unknown) => Promise<unknown>) => { try { await fn({}); log.push("commit"); } catch { log.push("rollback"); throw new Error("rolled back"); } } } as never;
    await assert.rejects(runBatch(db, () => [failing, statement(log, "history")]), /rolled back/);
    assert.deepEqual(log, ["rollback"]);
  });
});
