import "server-only";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";

/**
 * Who a conversation is with, for the details column beside it on the
 * Messages and Email pages: the person, their organization, and the clients
 * (deals) either is part of, with what's coming up next.
 */

const { people, organizations, clients, activities } = schema;

export async function recordContext(links: { personId: string | null; organizationId: string | null }) {
  const db = await getDb();
  const [person] = links.personId
    ? await db
        .select({
          id: people.id,
          firstName: people.firstName,
          lastName: people.lastName,
          title: people.title,
          email: people.email,
          phone: people.phone,
          ownerId: people.ownerId,
          organizationId: people.organizationId,
          tags: people.tags,
          decisionMaker: people.decisionMaker,
          textOptOutAt: people.textOptOutAt,
          unsubscribedAt: people.unsubscribedAt,
          lastActivityAt: people.lastActivityAt,
          summary: people.summary,
          archivedAt: people.archivedAt,
        })
        .from(people)
        .where(eq(people.id, links.personId))
    : [];
  const organizationId = person?.organizationId ?? links.organizationId;
  const [organization] = organizationId
    ? await db
        .select({ id: organizations.id, name: organizations.name, domain: organizations.domain, phone: organizations.phone, industry: organizations.industry, ownerId: organizations.ownerId })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
    : [];
  if (!person && !organization) return null;

  const tied = [person ? eq(clients.personId, person.id) : undefined, organization ? eq(clients.organizationId, organization.id) : undefined].filter(Boolean);
  const deals = await db
    .select({ id: clients.id, name: clients.name, category: clients.category, stageId: clients.stageId, value: clients.value, ownerId: clients.ownerId, expectedCloseDate: clients.expectedCloseDate, health: clients.health })
    .from(clients)
    .where(and(isNull(clients.archivedAt), or(...tied)))
    .orderBy(sql`case ${clients.category} when 'prospective' then 0 when 'current' then 1 else 2 end`, desc(clients.updatedAt))
    .limit(10);

  // The next planned thing with them: an open task, call or meeting with a due date.
  const about = [person ? eq(activities.personId, person.id) : undefined, !person && organization ? eq(activities.organizationId, organization.id) : undefined].filter(Boolean);
  const [next] = await db
    .select({ id: activities.id, type: activities.type, subject: activities.subject, dueAt: activities.dueAt, dueHasTime: activities.dueHasTime, assigneeId: activities.assigneeId })
    .from(activities)
    .where(and(or(...about), isNull(activities.completedAt), sql`${activities.dueAt} is not null`))
    .orderBy(asc(activities.dueAt))
    .limit(1);

  return {
    person: person
      ? {
          id: person.id,
          name: [person.firstName, person.lastName].filter(Boolean).join(" "),
          title: person.title,
          email: person.email,
          phone: person.phone,
          ownerId: person.ownerId,
          tags: person.tags,
          decisionMaker: person.decisionMaker,
          summary: person.summary,
          textOptedOut: !!person.textOptOutAt,
          unsubscribed: !!person.unsubscribedAt,
          archived: !!person.archivedAt,
          lastActivityAt: person.lastActivityAt?.toISOString() ?? null,
        }
      : null,
    organization: organization ?? null,
    deals,
    next: next ? { ...next, dueAt: next.dueAt!.toISOString() } : null,
  };
}

export type RecordContext = NonNullable<Awaited<ReturnType<typeof recordContext>>>;
