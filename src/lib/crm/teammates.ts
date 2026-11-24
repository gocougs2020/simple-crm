import "server-only";
import { cache } from "react";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { ClientCategory } from "@/lib/constants";
import { inviteState, type InviteState } from "@/lib/invite-state";

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
      joined: sql<boolean>`${users.passwordHash} is not null`,
      lastSeenAt: users.lastSeenAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, id));
  if (!row) return null;
  const { joined, ...rest } = row;
  return { ...rest, invite: (await inviteStates([{ id: row.id, joined }])).get(row.id) ?? null };
});

export type Teammate = NonNullable<Awaited<ReturnType<typeof getTeammate>>>;

/** The invite state of each teammate in `rows`, from their latest unused invite link. Expired links are pruned daily, so "expired" only lasts until then. */
export async function inviteStates(rows: { id: string; joined: boolean }[], now = new Date()): Promise<Map<string, InviteState>> {
  const waiting = rows.filter((r) => !r.joined).map((r) => r.id);
  const t = schema.authTokens;
  const db = await getDb();
  const tokens = waiting.length
    ? await db
        .select({ userId: t.userId, expiresAt: t.expiresAt })
        .from(t)
        .where(and(inArray(t.userId, waiting), eq(t.kind, "invite"), isNull(t.usedAt)))
    : [];
  const latest = new Map<string, Date>();
  for (const tok of tokens) if (!latest.has(tok.userId) || latest.get(tok.userId)! < tok.expiresAt) latest.set(tok.userId, tok.expiresAt);
  return new Map(rows.map((r) => [r.id, inviteState(r.joined, latest.get(r.id) ?? null, now)]));
}

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
