import "server-only";
import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { interactionTypes, type ActivityType } from "@/lib/constants";
import { actorUserId, assertCan, can, stamp, type Actor } from "@/lib/crm/actor";
import { resolveLinks } from "@/lib/crm/activities";
import { recordEvent, touch } from "@/lib/crm/events";
import { activityInput, type ActivityInput } from "@/lib/crm/schemas";
import { assertOrganization, assertPerson, assertUser } from "@/lib/crm/service/records";
import { ActionError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { calendarChanged, calendarRemoved } from "@/lib/microsoft/calendar";
import { calendarTypes } from "@/lib/microsoft/config";
import { taskAssigned } from "@/lib/push/triggers";
import { mentionsAgent } from "@/lib/agent/run-rules";
import { htmlToText, sanitizeHtml, textToHtml } from "@/lib/safe-html";

/**
 * Notes, calls, emails, texts, meetings and tasks. Shared by the browser, the
 * API and MCP. Notes and tasks can stand alone; interactions (calls, emails,
 * texts, meetings) need someone on the other side.
 */

const { activities, clients } = schema;

function cleanBody(body: string | null | undefined) {
  const html = sanitizeHtml(body);
  return html.replace(/<p><\/p>/g, "").trim() ? html : null;
}

/** Rich text from the editor (or HTML from the API) is kept and sanitized; anything else is plain text, escaped into paragraphs. */
const richTag = /<(p|br|h[1-6]|strong|b|em|i|u|s|a|ul|ol|li|blockquote|code|pre)\b[^>]*>/i;
function bodyFrom(body: string | null | undefined) {
  if (!body || richTag.test(body)) return body;
  return textToHtml(body);
}

/** Whether this kind of activity is copied to the assignee's Outlook calendar when planned. */
const onCalendar = (type: ActivityType) => (calendarTypes() as string[]).includes(type);

async function getActivityRow(activityId: string) {
  const db = await getDb();
  const [a] = await db.select().from(activities).where(eq(activities.id, z.uuid().parse(activityId)));
  if (!a) throw new NotFoundError("This activity was deleted.");
  return a;
}

async function checkLinks(l: { personId?: string | null; organizationId?: string | null; assigneeId?: string | null }) {
  await Promise.all([assertPerson(l.personId), assertOrganization(l.organizationId), assertUser(l.assigneeId, "assignee")]);
}

/** Loaded on demand: the agent's run service uses this file to save its answers. */
const handoff = () => import("@/lib/agent/handoff");

/**
 * Whether a new note calls on the agent. Only a note a teammate wrote
 * themselves, in the browser: text written by an agent or a script (any key,
 * the agent included) never starts work, whatever it says.
 */
const calledOn = (a: Actor, type: ActivityType, body: string | null) => type === "note" && a.kind === "user" && !a.keyId && mentionsAgent(htmlToText(body));

export async function logActivity(a: Actor, input: ActivityInput, opts: { requireLink?: boolean; handOff?: boolean } = {}) {
  assertCan(a, "records:write");
  const data = activityInput.parse(input);
  // A task for the agent: check it can take work before saving anything, so a refusal doesn't leave a task behind.
  const forAssistant = opts.handOff !== false && data.type === "task" && !!data.agent;
  if (forAssistant) await (await handoff()).assertCanHandOff(a);
  await checkLinks(data);
  const links = await resolveLinks(data);
  const linked = !!(links.personId || links.organizationId || links.clientId);
  if (!linked && (opts.requireLink || interactionTypes.includes(data.type))) throw new ActionError("Link this to a person, organization or client.");
  const body = cleanBody(bodyFrom(data.body));
  if (!body && !data.subject && (data.type === "note" || data.type === "task")) throw new ActionError(data.type === "note" ? "Write something first." : "Give the task a name.");
  const now = new Date();
  // Things that happened are done the moment they're logged; tasks and planned calls stay open until checked off.
  const done = data.done ?? (data.type !== "task" && !data.dueAt);
  const occurredAt = done ? (data.occurredAt ? new Date(data.occurredAt) : now) : null;
  const db = await getDb();
  const assigneeId = data.assigneeId === undefined ? actorUserId(a) : data.assigneeId;
  const [row] = await db
    .insert(activities)
    .values({
      type: data.type,
      subject: data.subject,
      body,
      direction: data.direction ?? null,
      outcome: data.outcome || null,
      durationMinutes: data.durationMinutes ?? null,
      occurredAt,
      dueAt: data.dueAt ? new Date(data.dueAt) : null,
      dueHasTime: data.dueHasTime ?? false,
      completedAt: done && data.dueAt ? now : null,
      assigneeId,
      ...stamp(a),
      ...links,
    })
    .returning({ id: activities.id });
  if (done) await touch(links, occurredAt ?? now);
  else {
    taskAssigned(a, { id: row.id, subject: data.subject ?? null, type: data.type, assigneeId, ...links });
    if (onCalendar(data.type)) calendarChanged(row.id);
  }
  const handed = { id: row.id, type: data.type, subject: data.subject ?? null, body, ...links };
  if (forAssistant) await (await handoff()).handOff(a, handed, "task");
  else if (opts.handOff !== false && calledOn(a, data.type, body)) await (await handoff()).handOffMention(a, handed);
  return row;
}

export async function updateActivity(a: Actor, activityId: string, patch: Partial<ActivityInput>) {
  assertCan(a, "records:write");
  const data = activityInput.partial().parse(patch);
  await checkLinks(data);
  if (data.agent) await (await handoff()).assertCanHandOff(a, z.uuid().parse(activityId));
  const db = await getDb();
  const before = await getActivityRow(activityId);
  // Anyone can reschedule or reassign a task; only the author (or an admin) can rewrite what was logged.
  const contentChange = data.body !== undefined || data.subject !== undefined || data.outcome !== undefined || data.direction !== undefined;
  // A forwarded call is logged by nobody; the teammate it rang writes it up.
  const authorOrModerator = before.userId === actorUserId(a) || can(a, "activities:moderate") || (!!before.callId && !before.userId && before.assigneeId === actorUserId(a));
  if (contentChange && !authorOrModerator && before.type !== "task") throw new ForbiddenError("Only the person who logged this can edit it.");
  // Changing what kind of activity it is counts as rewriting it, with no exemption for tasks: otherwise turning someone's call into a task would unlock editing it.
  if (data.type !== undefined && data.type !== before.type && !authorOrModerator) throw new ForbiddenError("Only the person who logged this, or an admin, can change what kind of activity it is.");
  if (data.type !== undefined && data.type !== before.type && (before.emailId || before.inboxThreadId || before.syncedEmailId)) throw new ActionError("Emails sent or received through the CRM stay emails.");
  if (data.type !== undefined && data.type !== before.type && (before.callId || before.textMessageId)) throw new ActionError("Calls and texts made through the CRM keep their type.");
  const links = data.personId !== undefined || data.organizationId !== undefined || data.clientId !== undefined ? await resolveLinks({ ...before, ...data }) : {};
  await db
    .update(activities)
    .set({
      ...(data.subject !== undefined ? { subject: data.subject } : {}),
      ...(data.body !== undefined ? { body: cleanBody(bodyFrom(data.body)) } : {}),
      ...(data.direction !== undefined ? { direction: data.direction } : {}),
      ...(data.outcome !== undefined ? { outcome: data.outcome || null } : {}),
      ...(data.durationMinutes !== undefined ? { durationMinutes: data.durationMinutes } : {}),
      ...(data.occurredAt !== undefined ? { occurredAt: data.occurredAt ? new Date(data.occurredAt) : null } : {}),
      ...(data.dueAt !== undefined ? { dueAt: data.dueAt ? new Date(data.dueAt) : null } : {}),
      ...(data.dueHasTime !== undefined ? { dueHasTime: data.dueHasTime } : {}),
      ...(data.assigneeId !== undefined ? { assigneeId: data.assigneeId } : {}),
      ...(data.type !== undefined ? { type: data.type } : {}),
      ...links,
      updatedAt: new Date(),
    })
    .where(eq(activities.id, before.id));
  if (before.calendarEventId || onCalendar(data.type ?? before.type)) calendarChanged(before.id);
  if (data.assigneeId && data.assigneeId !== before.assigneeId && (before.dueAt || before.type === "task")) {
    taskAssigned(a, { ...before, ...links, subject: data.subject !== undefined ? data.subject : before.subject, assigneeId: data.assigneeId });
  }
  // An open task handed to the agent after the fact.
  if (data.agent && (data.type ?? before.type) === "task" && !before.completedAt) {
    const [now] = await db.select().from(activities).where(eq(activities.id, before.id));
    if (now) await (await handoff()).handOff(a, now, "task");
  }
  return { id: before.id };
}

/**
 * Checks a task off (or back on). Returns whether the linked prospect or
 * current client is left with nothing planned, so the interface can offer to
 * schedule the next step.
 */
export async function setCompleted(a: Actor, activityId: string, completed: boolean) {
  assertCan(a, "records:write");
  const db = await getDb();
  const now = new Date();
  const [row] = await db
    .update(activities)
    .set({ completedAt: completed ? now : null, occurredAt: completed ? now : null, updatedAt: now })
    .where(eq(activities.id, z.uuid().parse(activityId)))
    .returning();
  if (!row) throw new NotFoundError("This activity was deleted.");
  if (completed) await touch(row, now);
  let clientWithoutNext: string | null = null;
  if (completed && row.clientId) {
    const [c] = await db.select({ category: clients.category }).from(clients).where(eq(clients.id, row.clientId));
    const [next] = await db
      .select({ id: activities.id })
      .from(activities)
      .where(and(eq(activities.clientId, row.clientId), isNull(activities.completedAt), isNotNull(activities.dueAt), ne(activities.id, row.id)))
      .limit(1);
    if (c && c.category !== "past" && !next) clientWithoutNext = row.clientId;
  }
  if (row.type === "task" && completed && row.assigneeId && row.assigneeId !== actorUserId(a) && row.clientId) {
    await recordEvent({ entityType: "client", entityId: row.clientId, action: "task_completed_for", data: { subject: row.subject, assigneeId: row.assigneeId }, ...stamp(a) });
  }
  return { id: row.id, clientWithoutNext };
}

export async function setPinned(a: Actor, activityId: string, pinned: boolean) {
  assertCan(a, "records:write");
  const db = await getDb();
  const rows = await db.update(activities).set({ pinned }).where(eq(activities.id, z.uuid().parse(activityId))).returning({ id: activities.id });
  if (!rows.length) throw new NotFoundError("This activity was deleted.");
}

/** Messages: what was said, as opposed to notes and tasks the team wrote for itself. Their history entry never repeats the subject. */
const messageTypes: ActivityType[] = ["email", "text", "call"];

/**
 * Deletes anything on a timeline: a note, task, meeting, call, text or email,
 * including ones sent or received through the CRM (a sensitive email that got
 * through, say). It disappears from every record for everyone. Admins can
 * delete anything; everyone else only what they sent or logged themselves,
 * plus mail copied from their own connected mailbox. `type`, when given,
 * refuses anything else (DELETE /notes/{id} can't delete a call).
 *
 * What's behind it stays, emptied where it held content, so a later sync or
 * webhook never puts it back: synced mail is marked kept out, inbox mail is
 * hidden from its conversation, a text's words are cleared.
 */
export async function deleteActivity(a: Actor, activityId: string, type?: ActivityType) {
  assertCan(a, "records:write");
  const db = await getDb();
  const [row] = await db.select().from(activities).where(eq(activities.id, z.uuid().parse(activityId)));
  if (!row || (type && row.type !== type)) {
    if (type) throw new NotFoundError(`There's no ${type} with that id.`);
    return;
  }
  const me = actorUserId(a);
  const mailboxOwner = row.syncedEmailId
    ? (
        await db
          .select({ userId: schema.connectedAccounts.userId })
          .from(schema.syncedEmails)
          .innerJoin(schema.connectedAccounts, eq(schema.connectedAccounts.id, schema.syncedEmails.accountId))
          .where(eq(schema.syncedEmails.id, row.syncedEmailId))
      )[0]?.userId
    : null;
  const own = !!me && (row.userId === me || mailboxOwner === me);
  if (!own && !can(a, "activities:moderate")) throw new ForbiddenError("You can delete what you sent or logged yourself. Ask an admin to delete this.");

  // Tombstones first: once the activity is gone, its links to them are cleared.
  if (row.inboxThreadId) await db.update(schema.inboxMessages).set({ hiddenAt: new Date() }).where(eq(schema.inboxMessages.activityId, row.id));
  await db.delete(activities).where(eq(activities.id, row.id));
  if (row.syncedEmailId) await db.update(schema.syncedEmails).set({ status: "withheld", reason: "Deleted from the record" }).where(eq(schema.syncedEmails.id, row.syncedEmailId));
  if (row.textMessageId) await db.update(schema.textMessages).set({ body: "", media: [], updatedAt: new Date() }).where(eq(schema.textMessages.id, row.textMessageId));
  calendarRemoved(row);

  const entity = row.clientId ? ("client" as const) : row.personId ? ("person" as const) : row.organizationId ? ("organization" as const) : null;
  if (entity)
    await recordEvent({
      entityType: entity,
      entityId: (row.clientId ?? row.personId ?? row.organizationId)!,
      action: "activity_deleted",
      // A deleted email or text may have been deleted for what it said: the history only says one was removed.
      data: { type: row.type, ...(messageTypes.includes(row.type) ? {} : { subject: row.subject }) },
      ...stamp(a),
    });
}
