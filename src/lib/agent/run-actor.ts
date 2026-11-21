import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { AuthResult } from "@/lib/api/auth";
import { assistantActor } from "./actor";
import { runAccess } from "./run-access";
import { verifyRunToken } from "./run-token";

/**
 * Who a background run's token acts as when it reaches MCP: the teammate the
 * run works for, through their "assistant" key row, so history reads
 * "Sam via Agent". Checked on every request: the run must still be going
 * and the teammate still active, and their role is read fresh, so cancelling
 * a run or changing someone's access takes effect at once. The run, the
 * teammate and their assistant key are one read.
 */
const fail = (message: string): AuthResult => ({ ok: false, error: { status: 401, code: "unauthorized", message, tokenPresented: true } });

export async function runActor(token: string): Promise<AuthResult> {
  const claims = await verifyRunToken("crm", token);
  if (!claims) return fail("That background task's access has expired.");
  const db = await getDb();
  const k = schema.apiKeys;
  const [row] = await db
    .select({ run: { id: schema.agentRuns.id, status: schema.agentRuns.status }, user: schema.users, key: k, hasKey: sql<boolean>`${k.id} is not null` })
    .from(schema.agentRuns)
    .innerJoin(schema.users, eq(schema.users.id, schema.agentRuns.userId))
    .leftJoin(k, and(eq(k.userId, schema.users.id), eq(k.kind, "assistant"), isNull(k.revokedAt)))
    .where(and(eq(schema.agentRuns.id, claims.runId), eq(schema.agentRuns.userId, claims.userId)))
    .limit(1);
  const access = runAccess(row && { status: row.run.status, deactivatedAt: row.user.deactivatedAt });
  if (!access.ok) return fail(access.message);
  if (row.hasKey && row.key) return { ok: true, actor: { kind: "user", user: row.user, keyId: row.key.id, runId: row.run.id }, key: row.key };
  // No assistant key yet (a teammate's first background run before they ever used the agent): make it, the one time.
  const actor = await assistantActor(row.user);
  const [key] = await db.select().from(k).where(eq(k.id, actor.keyId!));
  if (!key) return fail("That background task's access has expired.");
  return { ok: true, actor: { ...actor, runId: row.run.id }, key };
}
