"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { run, type Result } from "@/lib/action";
import { actionUser } from "@/lib/auth";
import { sessionActor } from "@/lib/crm/actor";
import type { ActivityInput } from "@/lib/crm/schemas";
import * as svc from "@/lib/crm/service/activities";
import { activityBody } from "@/lib/crm/activities";

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
