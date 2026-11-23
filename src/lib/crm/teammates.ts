import "server-only";
import { cache } from "react";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { ClientCategory } from "@/lib/constants";

const { users, clients, stages, people, organizations } = schema;

/**
 * A teammate as their page shows them to the rest of the team: who they are
 * and whether they can sign in. Never the password hash or their prefs.
 */
export const getTeammate = cache(async (id: string) => {
  const db = await getDb();
  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      title: users.title,
      deactivatedAt: users.deactivatedAt,
      invited: sql<boolean>`${users.passwordHash} is null`,
      lastSeenAt: users.lastSeenAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, id));
  return row ?? null;
});

export type Teammate = NonNullable<Awaited<ReturnType<typeof getTeammate>>>;

/** Whether an id is a teammate's, so a link that guessed the wrong page can still land on theirs. */
export async function isTeammate(id: string) {
  const db = await getDb();
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
  return !!row;
}

/** How many unarchived records a teammate owns, and their prospects and current clients, most recently moved first. */
export async function ownedBy(userId: string, limit = 8) {
  const db = await getDb();
  const [byCategory, [peopleCount], [orgCount], list] = await Promise.all([
    db
      .select({ category: clients.category, n: count() })
      .from(clients)
      .where(and(eq(clients.ownerId, userId), isNull(clients.archivedAt)))
      .groupBy(clients.category),
    db
      .select({ n: count() })
      .from(people)
      .where(and(eq(people.ownerId, userId), isNull(people.archivedAt))),
    db
      .select({ n: count() })
      .from(organizations)
      .where(and(eq(organizations.ownerId, userId), isNull(organizations.archivedAt))),
    db
      .select({ id: clients.id, name: clients.name, category: clients.category, value: clients.value, stageName: stages.name })
      .from(clients)
      .innerJoin(stages, eq(stages.id, clients.stageId))
      .where(and(eq(clients.ownerId, userId), isNull(clients.archivedAt), inArray(clients.category, ["prospective", "current"])))
      .orderBy(desc(clients.stageChangedAt))
      .limit(limit),
  ]);
  const clientCounts = Object.fromEntries(byCategory.map((r) => [r.category, r.n])) as Partial<Record<ClientCategory, number>>;
  return { clients: clientCounts, people: peopleCount?.n ?? 0, organizations: orgCount?.n ?? 0, list };
}
