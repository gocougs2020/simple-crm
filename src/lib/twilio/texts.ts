import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { TextStatus } from "@/db/schema";
import { touch } from "@/lib/crm/events";
import { hasPhone, linksForPhone, type Links } from "@/lib/crm/match";
import { recordEvent } from "@/lib/crm/events";
import { workspaceToday } from "@/lib/crm/inputs";
import { zonedTime } from "@/lib/format";
import { formatPhone, matchKey } from "@/lib/phone/numbers";
import { laterTextStatus, optKeyword } from "@/lib/phone/rules";
import { notify } from "@/lib/push/notify";
import { textToHtml } from "@/lib/safe-html";
import { getWorkspace } from "@/lib/workspace";
import { numberByE164, type PhoneNumber } from "./access";
import { twilio, TwilioError } from "./client";
import { WEBHOOKS } from "./config";

/**
 * Texts, one to one. Each one sent or received is a `text_messages` row and
 * a text activity on the person it's with, so texts are on the timeline next
 * to calls and email. Replies of STOP opt the person out; START opts them back in.
 */

const { textMessages, activities, people } = schema;

/** Twilio's code for "this person opted out of texts from this number". */
const OPTED_OUT = 21610;

type Send = {
  number: PhoneNumber;
  to: string;
  body: string;
  userId: string | null;
  links: Links;
  campaignId?: string | null;
  origin: string;
};

/**
 * Sends one text and records it. The row is saved before Twilio is asked, so
 * a status report can never beat it; a send Twilio refuses is kept as failed
 * with the reason. Returns the row and whether it went.
 */
export async function sendText(s: Send) {
  const db = await getDb();
  const [row] = await db
    .insert(textMessages)
    .values({ direction: "outbound", from: s.number.number, to: s.to, body: s.body, status: "queued", phoneNumberId: s.number.id, userId: s.userId, campaignId: s.campaignId ?? null, ...s.links })
    .onConflictDoNothing()
    .returning();
  // A campaign text this person already got (unique campaign + person): nothing to do.
  if (!row) return { row: null, sent: false as const };
  try {
    const msg = await twilio<{ sid: string; status: TextStatus }>("POST", "/Messages", { From: s.number.number, To: s.to, Body: s.body, StatusCallback: `${s.origin}${WEBHOOKS.smsStatus}` });
    await db.update(textMessages).set({ messageSid: msg.sid, status: msg.status === "queued" ? "queued" : "sending", updatedAt: new Date() }).where(eq(textMessages.id, row.id));
  } catch (err) {
    const message = err instanceof TwilioError ? err.message : "Twilio didn't take the text.";
    await db.update(textMessages).set({ status: "failed", error: message, updatedAt: new Date() }).where(eq(textMessages.id, row.id));
    if (err instanceof TwilioError && err.code === OPTED_OUT) await optOut(s.to, true);
    return { row: { ...row, status: "failed" as const, error: message }, sent: false as const, error: message };
  }
  return { row, sent: true as const };
}

/** Logs a sent text on the timeline. Campaign texts don't count as personal contact. */
export async function logSentText(row: typeof textMessages.$inferSelect, opts: { campaign?: boolean } = {}) {
  const db = await getDb();
  const now = new Date();
  const [a] = await db
    .insert(activities)
    .values({
      type: "text",
      direction: "outbound",
      body: textToHtml(row.body),
      occurredAt: now,
      userId: row.userId,
      assigneeId: row.userId,
      textMessageId: row.id,
      personId: row.personId,
      organizationId: row.organizationId,
      clientId: row.clientId,
    })
    .returning({ id: activities.id });
  if (!opts.campaign) await touch(row, now);
  return a;
}

/** Marks everyone with this phone number as opted out of (or back in to) texts, with a history entry each. */
async function optOut(phone: string, out: boolean) {
  const key = matchKey(phone);
  if (key.length < 7) return;
  const db = await getDb();
  const changed = await db
    .update(people)
    .set({ textOptOutAt: out ? new Date() : null })
    .where(and(hasPhone(key), out ? isNull(people.textOptOutAt) : sql`${people.textOptOutAt} is not null`))
    .returning({ id: people.id });
  for (const p of changed) await recordEvent({ entityType: "person", entityId: p.id, action: out ? "texts_opted_out" : "texts_opted_in", data: { phone: formatPhone(phone) }, userId: null });
}

/** A text to one of the numbers: saved, put on the sender's timeline, and their owner told. */
export async function receiveText(p: Record<string, string>) {
  const number = p.To ? await numberByE164(p.To) : null;
  if (!number || !p.MessageSid) return;
  const db = await getDb();
  const links = await linksForPhone(p.From ?? "");
  const media = Array.from({ length: Math.min(Number(p.NumMedia ?? 0) || 0, 10) }, (_, i) => ({ url: p[`MediaUrl${i}`] ?? "", contentType: p[`MediaContentType${i}`] ?? "" })).filter((m) => m.url.startsWith("https://"));
  const body = (p.Body ?? "").slice(0, 5000);
  const [row] = await db
    .insert(textMessages)
    .values({ messageSid: p.MessageSid, direction: "inbound", from: p.From ?? "", to: number.number, body, media, status: "received", phoneNumberId: number.id, personId: links.personId, organizationId: links.organizationId, clientId: links.clientId })
    .onConflictDoNothing()
    .returning();
  // Twilio retried a webhook that already landed.
  if (!row) return;
  try {
    await logReceived(row, number, links, media.length);
  } catch (err) {
    // Without its timeline entry the text would be lost: forget it, so Twilio's retry (the route answers 500) does it all again.
    await db.delete(textMessages).where(eq(textMessages.id, row.id));
    throw err;
  }
}

async function logReceived(row: typeof textMessages.$inferSelect, number: PhoneNumber, links: Awaited<ReturnType<typeof linksForPhone>>, mediaCount: number) {
  const db = await getDb();
  const body = row.body;
  const keyword = optKeyword(body);
  if (keyword) await optOut(row.from, keyword === "out");

  const now = new Date();
  const who = links.personName ?? links.organizationName ?? formatPhone(row.from);
  const html = textToHtml(body || (mediaCount ? `(${mediaCount === 1 ? "a picture or file" : `${mediaCount} pictures or files`})` : "(empty)"));
  if (links.personId || links.organizationId) {
    await db.insert(activities).values({ type: "text", direction: "inbound", body: html, occurredAt: now, userId: null, textMessageId: row.id, personId: links.personId, organizationId: links.organizationId, clientId: links.clientId });
    await touch(links, now);
  } else if (number.forwardUserId && !keyword) {
    // Nobody in the CRM has this number: a task, so the text isn't lost.
    const ws = await getWorkspace();
    await db.insert(activities).values({
      type: "task",
      subject: `Text from ${formatPhone(row.from)}`,
      body: textToHtml(`${body}\n\nTexted ${number.label}. Add them to the CRM to keep the conversation on their record.`),
      dueAt: zonedTime(await workspaceToday(), "00:00", ws.timezone),
      dueHasTime: false,
      userId: null,
      assigneeId: number.forwardUserId,
    });
  }
  const ownerId = await ownerOf(links) ?? number.forwardUserId;
  notify([ownerId], {
    kind: "inbound_text",
    title: `Text from ${who}`,
    body: body.slice(0, 140) || "Open it to see it.",
    url: links.personId ? `/people/${links.personId}` : links.organizationId ? `/organizations/${links.organizationId}` : "/activities",
    dedupeKey: `text:${row.id}`,
  });
}

async function ownerOf(l: Links) {
  const db = await getDb();
  const owner = async (table: typeof schema.clients | typeof schema.people | typeof schema.organizations, id: string | null) =>
    id ? ((await db.select({ ownerId: table.ownerId }).from(table).where(inArray(table.id, [id])))[0]?.ownerId ?? null) : null;
  return (await owner(schema.clients, l.clientId)) ?? (await owner(schema.people, l.personId)) ?? (await owner(schema.organizations, l.organizationId));
}

/** Delivery reports for texts the CRM sent. Status only moves forward. */
export async function recordTextStatus(p: Record<string, string>) {
  const status = p.MessageStatus as TextStatus | undefined;
  if (!p.MessageSid || !status) return { retryLater: false };
  const db = await getDb();
  const [row] = await db.select().from(textMessages).where(eq(textMessages.messageSid, p.MessageSid));
  // The send is still saving its sid: Twilio retries a 5xx.
  if (!row) return { retryLater: true };
  if (!laterTextStatus(row.status, status)) return { retryLater: false };
  const error = p.ErrorCode ? `Twilio error ${p.ErrorCode}${p.ErrorMessage ? `: ${p.ErrorMessage}` : ""}` : null;
  await db
    .update(textMessages)
    .set({ status, ...(error ? { error } : {}), updatedAt: new Date() })
    .where(eq(textMessages.id, row.id));
  if (Number(p.ErrorCode) === OPTED_OUT) await optOut(row.to, true);
  return { retryLater: false };
}
