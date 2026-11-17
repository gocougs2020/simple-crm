import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { linksForPhone, type Links } from "@/lib/crm/match";
import { matchKey } from "@/lib/phone/numbers";
import { textToHtml } from "@/lib/safe-html";

/**
 * Text conversations (`text_threads`) for the Messages page: one per pair of
 * our number and their number. Every text, sent or received, joins one, so
 * the conversation has the whole back and forth.
 */

const { textThreads, textMessages, activities } = schema;

/**
 * The conversation between one of our numbers and theirs, made the first time
 * either side texts. A text that knows who it's with updates the links, so a
 * number that's since been added to the CRM picks up its person.
 */
export async function threadFor(phoneNumberId: string, remote: string, links: Links) {
  const db = await getDb();
  const remoteKey = matchKey(remote);
  const linked = !!(links.personId || links.organizationId);
  const [row] = await db
    .insert(textThreads)
    .values({ phoneNumberId, remote, remoteKey, ...links })
    .onConflictDoUpdate({
      target: [textThreads.phoneNumberId, textThreads.remoteKey],
      targetWhere: sql`${textThreads.phoneNumberId} is not null`,
      set: linked ? { ...links, remote, updatedAt: new Date() } : { remote },
    })
    .returning({ id: textThreads.id });
  return row.id;
}

/**
 * Moves a conversation up the list for a one-to-one text, and leaves a reply
 * unread. Campaign texts join the conversation without moving it.
 */
export async function bumpThread(threadId: string, at: Date, direction: "inbound" | "outbound") {
  const db = await getDb();
  await db
    .update(textThreads)
    .set({
      lastMessageAt: sql`greatest(coalesce(${textThreads.lastMessageAt}, ${at}), ${at})`,
      ...(direction === "inbound" ? { read: false } : {}),
      updatedAt: new Date(),
    })
    .where(eq(textThreads.id, threadId));
}

/**
 * A conversation with a number nobody in the CRM had, once the number is on a
 * record: the conversation, its texts and their timeline entries move onto it,
 * so the history someone added a person for isn't left behind.
 */
export async function adoptThread(threadId: string, links: Links) {
  if (!links.personId && !links.organizationId) return;
  const db = await getDb();
  const [won] = await db
    .update(textThreads)
    .set({ ...links, updatedAt: new Date() })
    .where(and(eq(textThreads.id, threadId), isNull(textThreads.personId), isNull(textThreads.organizationId)))
    .returning({ id: textThreads.id });
  if (!won) return;
  const orphans = await db
    .update(textMessages)
    .set({ ...links, updatedAt: new Date() })
    .where(and(eq(textMessages.threadId, threadId), isNull(textMessages.personId), isNull(textMessages.organizationId), isNull(textMessages.campaignId)))
    .returning();
  for (const m of orphans) {
    const [has] = await db.select({ id: activities.id }).from(activities).where(eq(activities.textMessageId, m.id)).limit(1);
    if (has) {
      await db.update(activities).set({ ...links, updatedAt: new Date() }).where(eq(activities.textMessageId, m.id));
      continue;
    }
    // Deleted from a record already (emptied): it stays deleted. A send Twilio refused never goes on a timeline.
    if ((!m.body && !m.media.length) || (m.direction === "outbound" && m.status === "failed")) continue;
    await db.insert(activities).values({
      type: "text",
      direction: m.direction,
      body: textToHtml(m.body || "(a picture or file)"),
      occurredAt: m.createdAt,
      userId: m.direction === "outbound" ? m.userId : null,
      assigneeId: m.direction === "outbound" ? m.userId : null,
      textMessageId: m.id,
      ...links,
    });
  }
}

/**
 * After a person is added with a phone number (or their number changes):
 * conversations with that number nobody in the CRM had move onto them.
 */
export async function adoptThreadsForPhone(phone: string | null | undefined) {
  const key = matchKey(phone);
  if (key.length < 7) return;
  const db = await getDb();
  const orphans = await db
    .select({ id: textThreads.id })
    .from(textThreads)
    .where(and(eq(textThreads.remoteKey, key), isNull(textThreads.personId), isNull(textThreads.organizationId)));
  if (!orphans.length) return;
  const links = await linksForPhone(phone!);
  for (const t of orphans) await adoptThread(t.id, { personId: links.personId, organizationId: links.organizationId, clientId: links.clientId });
}
