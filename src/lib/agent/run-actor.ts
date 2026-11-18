import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { AuthResult } from "@/lib/api/auth";
import { assistantActor } from "./actor";
import { verifyRunToken } from "./run-token";

/**
 * Who a background run's token acts as when it reaches MCP: the teammate the
 * run works for, through their "assistant" key row, so history reads
 * "Sam via Agent". Checked on every request: the run must still be going
 * and the teammate still active, and their role is read fresh, so cancelling
 * a run or changing someone's access takes effect at once.
 */
const fail = (message: string): AuthResult => ({ ok: false, error: { status: 401, code: "unauthorized", message, tokenPresented: true } });

export async function runActor(token: string): Promise<AuthResult> {
  const claims = await verifyRunToken("crm", token);
  if (!claims) return fail("That background task's access has expired.");
  const db = await getDb();
  const [row] = await db
    .select({ run: { id: schema.agentRuns.id, status: schema.agentRuns.status }, user: schema.users })
    .from(schema.agentRuns)
    .innerJoin(schema.users, eq(schema.users.id, schema.agentRuns.userId))
    .where(and(eq(schema.agentRuns.id, claims.runId), eq(schema.agentRuns.userId, claims.userId)));
  if (!row || row.run.status !== "running") return fail("That background task has ended, so it can't read or change anything more.");
  if (row.user.deactivatedAt) return fail("The teammate this background task works for was deactivated.");
  const actor = await assistantActor(row.user);
  const [key] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, actor.keyId!));
  if (!key) return fail("That background task's access has expired.");
  return { ok: true, actor: { ...actor, runId: row.run.id }, key };
}
