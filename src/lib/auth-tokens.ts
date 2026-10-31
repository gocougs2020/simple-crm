import "server-only";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { hashToken } from "./auth";

// Kept out of "use server" files: every export there is a public endpoint.

/** True until the first account exists. */
export async function needsSetup() {
  const db = await getDb();
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.users);
  return row.n === 0;
}

/** Looks up an unused, unexpired link for the page that shows the form. Doesn't use it up. */
export async function peekToken(token: string, kind: "invite" | "reset") {
  const db = await getDb();
  const [row] = await db
    .select({ user: schema.users })
    .from(schema.authTokens)
    .innerJoin(schema.users, eq(schema.users.id, schema.authTokens.userId))
    .where(
      and(
        eq(schema.authTokens.tokenHash, await hashToken(token)),
        eq(schema.authTokens.kind, kind),
        isNull(schema.authTokens.usedAt),
        gt(schema.authTokens.expiresAt, new Date()),
        isNull(schema.users.deactivatedAt),
      ),
    )
    .limit(1);
  return row ? { name: row.user.name, email: row.user.email } : null;
}

