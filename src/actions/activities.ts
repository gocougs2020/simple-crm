"use server";

import { refresh } from "next/cache";
import { run, type Result } from "@/lib/action";
import { actionUser } from "@/lib/auth";
import { sessionActor } from "@/lib/crm/actor";
import type { ActivityInput } from "@/lib/crm/schemas";
import * as svc from "@/lib/crm/service/activities";

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
