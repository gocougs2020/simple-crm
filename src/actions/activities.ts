"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { run, type Result } from "@/lib/action";
import { actionUser } from "@/lib/auth";
import { sessionActor } from "@/lib/crm/actor";
import type { ActivityInput } from "@/lib/crm/schemas";
import * as svc from "@/lib/crm/service/activities";
import { activityBody } from "@/lib/crm/activities";
import { orderPeople } from "@/lib/crm/people-order";
import { clientPeople, getClient, getOrganization, getPerson, peopleOf } from "@/lib/crm/records";
import { personName } from "@/lib/format";

export type { ActivityInput } from "@/lib/crm/schemas";

/** From a record's composer, an activity always belongs to that record. */
export async function logActivity(input: ActivityInput): Promise<Result<{ id: string }>> {
  return run(async () => {
    const row = await svc.logActivity(sessionActor(await actionUser()), input, { requireLink: true });
    refresh();
    return row;
  });
}

export async function updateActivity(activityId: string, patch: Partial<ActivityInput>): Promise<Result> {
  return run(async () => {
    await svc.updateActivity(sessionActor(await actionUser()), activityId, patch);
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
    const { clientWithoutNext } = await svc.setCompleted(sessionActor(await actionUser()), activityId, completed);
    refresh();
    return { clientWithoutNext };
  });
}

export async function setPinned(activityId: string, pinned: boolean): Promise<Result> {
  return run(async () => {
    await svc.setPinned(sessionActor(await actionUser()), activityId, pinned);
    refresh();
  });
}

export async function deleteActivity(activityId: string): Promise<Result> {
  return run(async () => {
    await svc.deleteActivity(sessionActor(await actionUser()), activityId);
    refresh();
  });
}

/** A reply under a note, from its thread on the timeline. */
export async function replyToNote(activityId: string, body: string): Promise<Result<{ id: string }>> {
  return run(async () => {
    const row = await svc.replyToNote(sessionActor(await actionUser()), activityId, { body });
    refresh();
    return row;
  });
}

export async function deleteReply(replyId: string): Promise<Result> {
  return run(async () => {
    await svc.deleteReply(sessionActor(await actionUser()), replyId);
    refresh();
  });
}

/** An activity's whole body, for "Show more" and editing in a list that only had its preview (the Activities page, the home feed). */
export async function loadActivityBody(activityId: string): Promise<Result<{ body: string | null }>> {
  return run(async () => {
    await actionUser();
    return { body: await activityBody(z.uuid().parse(activityId)) };
  });
}

type TargetContact = { personId: string; name: string; email: string | null; phone: string | null; textOptedOut: boolean; detail: string | null; starred: boolean };

/**
 * Who an activity started away from its record (the Activities page) can be
 * with, the same as that record's own composer: the person themselves, or a
 * client's or organization's people, contact first.
 */
export async function composerTarget(kind: "person" | "organization" | "client", recordId: string): Promise<Result<{ recipient: TargetContact | null; contacts: TargetContact[] }>> {
  return run(async () => {
    await actionUser();
    const id = z.uuid().parse(recordId);
    const contact = (p: { id: string; firstName: string; lastName: string | null; email: string | null; phone: string | null; textOptOutAt: Date | null; title: string | null; decisionMaker: boolean }, detail?: string | null): TargetContact => ({
      personId: p.id,
      name: personName(p),
      email: p.email,
      phone: p.phone,
      textOptedOut: !!p.textOptOutAt,
      detail: detail ?? p.title,
      starred: p.decisionMaker,
    });
    if (kind === "person") {
      const row = await getPerson(id);
      if (!row) throw new Error("That person isn't in the CRM anymore.");
      return { recipient: contact(row.person), contacts: [] };
    }
    if (kind === "client") {
      const row = await getClient(id);
      if (!row) throw new Error("That client isn't in the CRM anymore.");
      const contacts = (await clientPeople(row.client)).map(({ person: p, source }) => contact(p, source === "contact" ? ["Contact", p.title].filter(Boolean).join(", ") : p.title));
      return { recipient: contacts.find((c) => c.personId === row.client.personId) ?? contacts[0] ?? null, contacts };
    }
    if (!(await getOrganization(id))) throw new Error("That organization isn't in the CRM anymore.");
    const contacts = orderPeople((await peopleOf(id)).map((p) => contact(p)), (c) => c);
    return { recipient: null, contacts };
  });
}

/** As many as the Activities page lists at once (500 to do), so selecting all of them always works. */
const bulkIds = z.array(z.uuid()).min(1).max(500);
type BulkResult = { count: number; skipped: number; reason: string | null };

/**
 * The Activities page's bulk actions: each one goes through the same service
 * call as doing it one at a time, so the permission checks and history are the
 * same. One that's refused (someone else's to delete) is skipped and counted,
 * and the rest still go through.
 */
async function eachActivity(ids: string[], work: (id: string) => Promise<unknown>): Promise<BulkResult> {
  let count = 0;
  let skipped = 0;
  let reason: string | null = null;
  for (const id of bulkIds.parse(ids)) {
    try {
      await work(id);
      count++;
    } catch (err) {
      skipped++;
      reason ??= err instanceof Error ? err.message : "Couldn't change it.";
    }
  }
  refresh();
  return { count, skipped, reason };
}

export async function setCompletedMany(activityIds: string[], completed: boolean): Promise<Result<BulkResult>> {
  return run(async () => {
    const actor = sessionActor(await actionUser());
    return eachActivity(activityIds, (id) => svc.setCompleted(actor, id, completed));
  });
}

export async function deleteActivities(activityIds: string[]): Promise<Result<BulkResult>> {
  return run(async () => {
    const actor = sessionActor(await actionUser());
    return eachActivity(activityIds, (id) => svc.deleteActivity(actor, id));
  });
}
