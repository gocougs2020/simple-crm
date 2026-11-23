import { sql, type SQL } from "drizzle-orm";
import { activities } from "@/db/schema";
import type { EntityType } from "@/lib/constants";

/**
 * An activity is archived with the record it was logged on: its client when it
 * has one, else its person, else its organization. The links roll up (logged
 * on a client, it also carries the client's contact and organization), so the
 * most specific one is its home: archiving a contact doesn't take the open
 * tasks of a client they're on, and archiving an organization doesn't take
 * its people's. Nothing is copied onto the activity, so calls, texts and mail
 * that arrive later on an archived record are archived too, and restoring the
 * record brings everything back.
 *
 * Archived activities drop out of work lists (the Activities page, the home
 * page, the sidebar counts, reminders, the agenda email, the calendar, the
 * API's lists). They stay on the record's own timeline, like the rest of its
 * history.
 */

type Links = { clientId: SQL | typeof activities.clientId; personId: SQL | typeof activities.personId; organizationId: SQL | typeof activities.organizationId };

const own: Links = { clientId: activities.clientId, personId: activities.personId, organizationId: activities.organizationId };

/** The `activities a` columns, for raw SQL that reads the table under that alias. */
export const aliased = (alias: string): Links => ({
  clientId: sql.raw(`${alias}.client_id`),
  personId: sql.raw(`${alias}.person_id`),
  organizationId: sql.raw(`${alias}.organization_id`),
});

/** When the activity's home record was archived; null while it's live (or the activity is on no record). */
export function homeArchivedAt(l: Links = own) {
  return sql<Date | null>`(case
    when ${l.clientId} is not null then (select hc.archived_at from clients hc where hc.id = ${l.clientId})
    when ${l.personId} is not null then (select hp.archived_at from people hp where hp.id = ${l.personId})
    when ${l.organizationId} is not null then (select ho.archived_at from organizations ho where ho.id = ${l.organizationId})
  end)`;
}

/** The activity isn't archived: its home record is live, or it's on no record. */
export const activityLive = (l: Links = own) => sql`${homeArchivedAt(l)} is null`;

/** Whether the activity is archived, as a column. */
export const activityArchived = (l: Links = own) => sql<boolean>`${homeArchivedAt(l)} is not null`;

/** The activity's home is this record: the one it's archived with. */
export function homeIs(entity: EntityType, id: string | SQL, l: Links = own) {
  if (entity === "client") return sql`${l.clientId} = ${id}`;
  if (entity === "person") return sql`(${l.clientId} is null and ${l.personId} = ${id})`;
  return sql`(${l.clientId} is null and ${l.personId} is null and ${l.organizationId} = ${id})`;
}

/**
 * For a record's own page: live activities, and the archived ones that are
 * archived with this record (its history while it's archived). Leaves out
 * work from another archived record that rolled up to this one.
 */
export const shownOnRecord = (entity: EntityType, id: string | SQL, l: Links = own) => sql`(${activityLive(l)} or ${homeIs(entity, id, l)})`;
