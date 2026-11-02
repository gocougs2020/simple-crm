"use server";

import { refresh } from "next/cache";
import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { run, type Result } from "@/lib/action";
import { ActionError, actionUser, isAdmin } from "@/lib/auth";
import { activityTypes } from "@/lib/constants";
import { recordEvent, touch } from "@/lib/crm/events";
import { sanitizeHtml } from "@/lib/safe-html";

const { activities, clients, people } = schema;

const activityInput = z.object({
  type: z.enum(activityTypes),
  subject: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .optional()
    .transform((v) => v || null),
  body: z.string().max(100_000).nullable().optional(),
  direction: z.enum(["outbound", "inbound"]).nullable().optional(),
  outcome: z.string().trim().max(80).nullable().optional(),
  durationMinutes: z.number().int().min(0).max(24 * 60).nullable().optional(),
  occurredAt: z.iso.datetime({ offset: true }).nullable().optional(),
  dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
  dueHasTime: z.boolean().optional(),
  assigneeId: z.uuid().nullable().optional(),
  personId: z.uuid().nullable().optional(),
  organizationId: z.uuid().nullable().optional(),
  clientId: z.uuid().nullable().optional(),
  /** Logging something that already happened (a call you just made) vs planning it. */
  done: z.boolean().optional(),
});

export type ActivityInput = z.input<typeof activityInput>;

/**
 * Fills in the links an activity implies: logged on a client, it also shows on
 * the client's contact and organization; logged on a person, on their
 * organization. That's what makes the organization page the whole story.
 */
async function resolveLinks(l: { personId?: string | null; organizationId?: string | null; clientId?: string | null }) {
  const db = await getDb();
  let { personId = null, organizationId = null } = l;
  const clientId = l.clientId ?? null;
  if (clientId) {
    const [d] = await db.select({ personId: clients.personId, organizationId: clients.organizationId }).from(clients).where(eq(clients.id, clientId));
    if (!d) throw new ActionError("That client was deleted.");
    personId ??= d.personId;
    organizationId ??= d.organizationId;
  }
  if (personId && !organizationId) {
    const [p] = await db.select({ organizationId: people.organizationId }).from(people).where(eq(people.id, personId));
    organizationId = p?.organizationId ?? null;
  }
  return { personId, organizationId, clientId };
}

function cleanBody(body: string | null | undefined) {
  const html = sanitizeHtml(body);
  return html.replace(/<p><\/p>/g, "").trim() ? html : null;
}

export async function logActivity(input: ActivityInput): Promise<Result<{ id: string }>> {
  return run(async () => {
    const user = await actionUser();
    const data = activityInput.parse(input);
    const links = await resolveLinks(data);
    if (!links.personId && !links.organizationId && !links.clientId) throw new ActionError("Link this to a person, organization or client.");
    const body = cleanBody(data.body);
    if (!body && !data.subject && (data.type === "note" || data.type === "task")) throw new ActionError(data.type === "note" ? "Write something first." : "Give the task a name.");
    const now = new Date();
    // Things that happened are done the moment they're logged; tasks and planned calls stay open until checked off.
    const done = data.done ?? (data.type !== "task" && !data.dueAt);
    const occurredAt = done ? (data.occurredAt ? new Date(data.occurredAt) : now) : null;
    const db = await getDb();
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
        assigneeId: data.assigneeId === undefined ? user.id : data.assigneeId,
        userId: user.id,
        ...links,
      })
      .returning({ id: activities.id });
    if (done) await touch(links, occurredAt ?? now);
    refresh();
    return row;
  });
}

export async function updateActivity(activityId: string, patch: Partial<ActivityInput>): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const data = activityInput.partial().parse(patch);
    const db = await getDb();
    const [a] = await db.select().from(activities).where(eq(activities.id, z.uuid().parse(activityId)));
    if (!a) throw new ActionError("This activity was deleted.");
    // Anyone can reschedule or reassign a task; only the author (or an admin) can rewrite what was logged.
    const contentChange = data.body !== undefined || data.subject !== undefined || data.outcome !== undefined || data.direction !== undefined;
    if (contentChange && a.userId !== user.id && !isAdmin(user) && a.type !== "task") throw new ActionError("Only the person who logged this can edit it.");
    const links = data.personId !== undefined || data.organizationId !== undefined || data.clientId !== undefined ? await resolveLinks({ ...a, ...data }) : {};
    await db
      .update(activities)
      .set({
        ...(data.subject !== undefined ? { subject: data.subject } : {}),
        ...(data.body !== undefined ? { body: cleanBody(data.body) } : {}),
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
      .where(eq(activities.id, a.id));
    refresh();
  });
}

/**
 * Checks a task off (or back on). Returns whether the linked prospect or
 * current client is left with nothing planned, so the interface can offer to
 * schedule the next step.
 */
export async function setCompleted(activityId: string, completed: boolean): Promise<Result<{ clientWithoutNext: string | null }>> {
  return run(async () => {
    const user = await actionUser();
    const db = await getDb();
    const now = new Date();
    const [a] = await db
      .update(activities)
      .set({ completedAt: completed ? now : null, occurredAt: completed ? now : null, updatedAt: now })
      .where(eq(activities.id, z.uuid().parse(activityId)))
      .returning();
    if (!a) throw new ActionError("This activity was deleted.");
    if (completed) await touch(a, now);
    let clientWithoutNext: string | null = null;
    if (completed && a.clientId) {
      const [c] = await db.select({ category: clients.category }).from(clients).where(eq(clients.id, a.clientId));
      const [next] = await db
        .select({ id: activities.id })
        .from(activities)
        .where(and(eq(activities.clientId, a.clientId), isNull(activities.completedAt), isNotNull(activities.dueAt), ne(activities.id, a.id)))
        .limit(1);
      if (c && c.category !== "past" && !next) clientWithoutNext = a.clientId;
    }
    if (a.type === "task" && completed && a.assigneeId && a.assigneeId !== user.id && a.clientId) {
      await recordEvent({ entityType: "client", entityId: a.clientId, action: "task_completed_for", data: { subject: a.subject, assigneeId: a.assigneeId }, userId: user.id });
    }
    refresh();
    return { clientWithoutNext };
  });
}

export async function setPinned(activityId: string, pinned: boolean): Promise<Result> {
  return run(async () => {
    await actionUser();
    const db = await getDb();
    await db.update(activities).set({ pinned }).where(eq(activities.id, z.uuid().parse(activityId)));
    refresh();
  });
}

export async function deleteActivity(activityId: string): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const db = await getDb();
    const [a] = await db.select().from(activities).where(eq(activities.id, z.uuid().parse(activityId)));
    if (!a) return;
    if (a.userId !== user.id && !isAdmin(user)) throw new ActionError("Only the person who logged this, or an admin, can delete it.");
    if (a.emailId || a.inboxThreadId) throw new ActionError("Emails sent or received through the CRM stay on the record.");
    await db.delete(activities).where(eq(activities.id, a.id));
    const entity = a.clientId ? ("client" as const) : a.personId ? ("person" as const) : ("organization" as const);
    await recordEvent({ entityType: entity, entityId: (a.clientId ?? a.personId ?? a.organizationId)!, action: "activity_deleted", data: { type: a.type, subject: a.subject }, userId: user.id });
    refresh();
  });
}
