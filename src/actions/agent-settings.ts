"use server";

import { refresh } from "next/cache";
import { run, type Result } from "@/lib/action";
import * as schedules from "@/lib/agent/schedules";
import * as skills from "@/lib/agent/skills";
import type { JobInput } from "@/lib/agent/schedule-rules";
import type { SkillInput } from "@/lib/agent/skill-rules";
import { actionEditor } from "@/lib/auth";
import { sessionActor } from "@/lib/crm/actor";

/**
 * Settings → Agent: skills and scheduled jobs. Each action is a thin wrapper
 * over the same service the API, MCP and the agent use (src/lib/agent/skills.ts,
 * schedules.ts), which checks who may change what and validates the input.
 */

/** Saves a new skill, or changes one. Sharing it with the team (scope: workspace) takes an admin. */
export async function saveSkill(id: string | null, input: Partial<SkillInput>): Promise<Result<{ id: string }>> {
  return run(async () => {
    const actor = sessionActor(await actionEditor());
    const row = id ? await skills.updateSkill(actor, id, input) : await skills.createSkill(actor, input as SkillInput);
    refresh();
    return { id: row.id };
  });
}

export async function deleteSkill(id: string): Promise<Result> {
  return run(async () => {
    await skills.deleteSkill(sessionActor(await actionEditor()), id);
    refresh();
  });
}

/** Saves a new scheduled job, or changes one. Offering it to the team (scope: workspace) takes an admin. */
export async function saveJob(id: string | null, input: Partial<JobInput>): Promise<Result<{ id: string }>> {
  return run(async () => {
    const actor = sessionActor(await actionEditor());
    const row = id ? await schedules.updateJob(actor, id, input) : await schedules.createJob(actor, input as JobInput);
    refresh();
    return { id: row.id };
  });
}

export async function deleteJob(id: string): Promise<Result> {
  return run(async () => {
    await schedules.deleteJob(sessionActor(await actionEditor()), id);
    refresh();
  });
}

/** Adds a job an admin offered to the team to the teammate's own, where it runs as them. */
export async function addSharedJob(id: string): Promise<Result<{ id: string }>> {
  return run(async () => {
    const row = await schedules.addSharedJob(sessionActor(await actionEditor()), id);
    refresh();
    return { id: row.id };
  });
}

/** Admins: offers a copy of a job to the whole team. */
export async function shareJob(id: string): Promise<Result<{ id: string }>> {
  return run(async () => {
    const row = await schedules.shareJob(sessionActor(await actionEditor()), id);
    refresh();
    return { id: row.id };
  });
}

/** Runs one of the teammate's jobs now, as a background task, without changing its schedule. */
export async function runJobNow(id: string): Promise<Result<{ taskId: string }>> {
  return run(async () => {
    const started = await schedules.runJobNow(sessionActor(await actionEditor()), id);
    refresh();
    return { taskId: started.id };
  });
}
