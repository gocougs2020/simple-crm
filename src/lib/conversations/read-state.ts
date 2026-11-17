import "server-only";
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { ActionError } from "@/lib/auth";
import { notYoursMessage, readStateFor } from "./read-rules";

/**
 * The SQL side of read-rules.ts, for the conversation lists and the sidebar
 * counts. A deactivated teammate owns nothing here, so their conversations
 * become everyone's rather than going unseen.
 */

type ConversationTable = "inbox_threads" | "text_threads";

/** The teammate a conversation's unread belongs to: the linked person's owner, else (no person linked) the organization's. Null: everyone's. */
export function conversationOwner(table: ConversationTable): SQL<string | null> {
  // Qualified by hand, so the subqueries never read a bare column as their own.
  const t = sql.raw(`"${table}"`);
  return sql<string | null>`(case when ${t}."person_id" is not null
    then (select p.owner_id from people p join users u on u.id = p.owner_id and u.deactivated_at is null where p.id = ${t}."person_id")
    else (select o.owner_id from organizations o join users u on u.id = o.owner_id and u.deactivated_at is null where o.id = ${t}."organization_id") end)`;
}

/** Shows as unread to this teammate: not read, and theirs or nobody's. */
export function unreadFor(table: ConversationTable, userId: string): SQL<boolean> {
  const t = sql.raw(`"${table}"`);
  const owner = conversationOwner(table);
  return sql<boolean>`(not ${t}."read" and (${owner} is null or ${owner} = ${userId}))`;
}

/** The owner of a conversation's record, and its name for messages. Same rule as `conversationOwner`. */
export async function ownerOfRecord(links: { personId: string | null; organizationId: string | null }) {
  const db = await getDb();
  if (links.personId) {
    const [p] = await db
      .select({ ownerId: schema.users.id, firstName: schema.people.firstName, lastName: schema.people.lastName })
      .from(schema.people)
      .leftJoin(schema.users, and(eq(schema.users.id, schema.people.ownerId), isNull(schema.users.deactivatedAt)))
      .where(eq(schema.people.id, links.personId));
    return { ownerId: p?.ownerId ?? null, recordName: p ? [p.firstName, p.lastName].filter(Boolean).join(" ") : null };
  }
  if (links.organizationId) {
    const [o] = await db
      .select({ ownerId: schema.users.id, name: schema.organizations.name })
      .from(schema.organizations)
      .leftJoin(schema.users, and(eq(schema.users.id, schema.organizations.ownerId), isNull(schema.users.deactivatedAt)))
      .where(eq(schema.organizations.id, links.organizationId));
    return { ownerId: o?.ownerId ?? null, recordName: o?.name ?? null };
  }
  return { ownerId: null, recordName: null };
}

/**
 * Whether this teammate may mark the conversation read or unread; refuses
 * with a sentence naming the owner otherwise. Returns the read state.
 */
export async function assertCanChangeRead(conversation: { read: boolean; personId: string | null; organizationId: string | null }, userId: string) {
  const { ownerId, recordName } = await ownerOfRecord(conversation);
  const state = readStateFor({ read: conversation.read, ownerId }, userId);
  if (!state.canChange) {
    const db = await getDb();
    const [owner] = ownerId ? await db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, ownerId)) : [];
    throw new ActionError(notYoursMessage(owner?.name, recordName));
  }
  return state;
}
