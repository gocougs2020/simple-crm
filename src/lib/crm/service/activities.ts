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
import { taskAssigned } from "@/lib/push/triggers";
import { sanitizeHtml, textToHtml } from "@/lib/safe-html";

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

async function getActivityRow(activityId: string) {
  const db = await getDb();
  const [a] = await db.select().from(activities).where(eq(activities.id, z.uuid().parse(activityId)));
  if (!a) throw new NotFoundError("This activity was deleted.");
  return a;
}

async function checkLinks(l: { personId?: string | null; organizationId?: string | null; assigneeId?: string | null }) {
  await Promise.all([assertPerson(l.personId), assertOrganization(l.organizationId), assertUser(l.assigneeId, "assignee")]);
}

export async function logActivity(a: Actor, input: ActivityInput, opts: { requireLink?: boolean } = {}) {
  assertCan(a, "records:write");
  const data = activityInput.parse(input);
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
  else taskAssigned(a, { id: row.id, subject: data.subject ?? null, type: data.type, assigneeId, ...links });
  return row;
}

export async function updateActivity(a: Actor, activityId: string, patch: Partial<ActivityInput>) {
  assertCan(a, "records:write");
  const data = activityInput.partial().parse(patch);
  await checkLinks(data);
  const db = await getDb();
  const before = await getActivityRow(activityId);
  // Anyone can reschedule or reassign a task; only the author (or an admin) can rewrite what was logged.
  const contentChange = data.body !== undefined || data.subject !== undefined || data.outcome !== undefined || data.direction !== undefined;
  const authorOrModerator = before.userId === actorUserId(a) || can(a, "activities:moderate");
  if (contentChange && !authorOrModerator && before.type !== "task") throw new ForbiddenError("Only the person who logged this can edit it.");
  // Changing what kind of activity it is counts as rewriting it, with no exemption for tasks: otherwise turning someone's call into a task would unlock editing it.
  if (data.type !== undefined && data.type !== before.type && !authorOrModerator) throw new ForbiddenError("Only the person who logged this, or an admin, can change what kind of activity it is.");
  if (data.type !== undefined && data.type !== before.type && (before.emailId || before.inboxThreadId)) throw new ActionError("Emails sent or received through the CRM stay emails.");
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
  if (data.assigneeId && data.assigneeId !== before.assigneeId && (before.dueAt || before.type === "task")) {
    taskAssigned(a, { ...before, ...links, subject: data.subject !== undefined ? data.subject : before.subject, assigneeId: data.assigneeId });
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

/** Deletes an activity. `type`, when given, refuses anything else (DELETE /notes/{id} can't delete a call). */
export async function deleteActivity(a: Actor, activityId: string, type?: ActivityType) {
  assertCan(a, "records:write");
  const db = await getDb();
  const [row] = await db.select().from(activities).where(eq(activities.id, z.uuid().parse(activityId)));
  if (!row || (type && row.type !== type)) {
    if (type) throw new NotFoundError(`There's no ${type} with that id.`);
    return;
  }
  if (row.userId !== actorUserId(a) && !can(a, "activities:moderate")) throw new ForbiddenError("Only the person who logged this, or an admin, can delete it.");
  if (row.emailId || row.inboxThreadId) throw new ActionError("Emails sent or received through the CRM stay on the record.");
  await db.delete(activities).where(eq(activities.id, row.id));
  const entity = row.clientId ? ("client" as const) : row.personId ? ("person" as const) : row.organizationId ? ("organization" as const) : null;
  if (entity) await recordEvent({ entityType: entity, entityId: (row.clientId ?? row.personId ?? row.organizationId)!, action: "activity_deleted", data: { type: row.type, subject: row.subject }, ...stamp(a) });
}
