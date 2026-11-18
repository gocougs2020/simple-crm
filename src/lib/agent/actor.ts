import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { appConfig } from "@/app.config";
import { getDb, schema } from "@/db";
import type { User } from "@/lib/auth";
import type { Actor } from "@/lib/crm/actor";

/**
 * The in-app agent acts as the signed-in teammate, on their session: no
 * API key to create, and their role decides what it can read and change, the
 * same way it does for them in the browser. Its changes are attributed to
 * them, through their "assistant" row in api_keys, so history reads
 * "Sam via Agent".
 */
export async function assistantActor(user: User): Promise<Actor & { kind: "user" }> {
  return { kind: "user", user, keyId: await assistantKeyId(user.id) };
}

async function assistantKeyId(userId: string) {
  const db = await getDb();
  const k = schema.apiKeys;
  const [found] = await db
    .select({ id: k.id })
    .from(k)
    .where(and(eq(k.userId, userId), eq(k.kind, "assistant"), isNull(k.revokedAt)))
    .limit(1);
  if (found) return found.id;
  // The token hash is random and never handed out: nothing can sign in with this row.
  const random = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const [row] = await db
    .insert(k)
    .values({ name: appConfig.agent.name, kind: "assistant", userId, prefix: "assistant", tokenHash: `assistant:${random}`, createdBy: userId })
    .returning({ id: k.id });
  return row.id;
}
