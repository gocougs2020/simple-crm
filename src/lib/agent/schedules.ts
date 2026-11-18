import "server-only";
import { and, asc, eq, isNotNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import type { User } from "@/lib/auth";
import type { AgentScope } from "@/lib/constants";
import { assertCan, can, type Actor } from "@/lib/crm/actor";
import { ActionError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { getWorkspace } from "@/lib/workspace";
import { assistantActor } from "./actor";
import { aiFeatures, aiOffMessage } from "./config";
import { startRun } from "./runs";
import { canEditJob, canSeeJob, cleanCadence, jobInput, jobPatch, MAX_JOBS, nextRun, type Cadence, type JobInput, type JobPatch } from "./schedule-rules";

/**
 * The agent's scheduled jobs: work it does on its own, on a cadence
 * (docs/AGENT.md). The settings page, the REST API, MCP and the agent itself
 * all come through here.
 * - A personal job runs as its teammate. The agent cron (every 15 minutes)
 *   starts a background run for each job whose time has come, so a job has
 *   exactly its teammate's access and counts against the same budgets as any
 *   other background work.
 * - A shared (workspace) job is an offer from an admin. It never runs itself:
 *   a teammate who adds it gets their own copy, which runs as them.
 * - The agent's background runs can read jobs but never write them, so a run
 *   can't schedule more of itself.
 */

const jobs = schema.agentSchedules;
export type Job = typeof jobs.$inferSelect;
export type JobRow = Job & { ownerName: string };

function teammate(a: Actor): User {
  if (a.kind !== "user") throw new ForbiddenError("Scheduled jobs run as one teammate, with their access. Use a personal key or a connected app, not a workspace key.");
  return a.user;
}

const who = (a: Actor) => ({ id: teammate(a).id, admin: can(a, "workspace:admin") });

/** Before any change: edit access, a teammate, not a run, and background work switched on. */
function assertCanChange(a: Actor) {
  assertCan(a, "records:write");
  const user = teammate(a);
  if (a.kind === "user" && a.runId) throw new ForbiddenError("Background work can read scheduled jobs but not change them. Ask in chat, or change it in Settings.");
  if (!aiFeatures().background) throw new ActionError(aiOffMessage("background"));
  return user;
}

async function rows(where: SQL | undefined) {
  const db = await getDb();
  const found = await db.select({ job: jobs, ownerName: schema.users.name }).from(jobs).innerJoin(schema.users, eq(schema.users.id, jobs.userId)).where(where).orderBy(asc(sql`lower(${jobs.name})`));
  return found.map((r): JobRow => ({ ...r.job, ownerName: r.ownerName }));
}

/**
 * The jobs this teammate can see: their own and the ones offered to the team.
 * `all` adds other teammates' jobs, for admins.
 */
export async function listJobs(a: Actor, opts: { scope?: "mine" | "shared" | "all" } = {}) {
  assertCan(a, "records:read");
  const user = teammate(a);
  const mine = and(eq(jobs.scope, "personal"), eq(jobs.userId, user.id));
  const shared = eq(jobs.scope, "workspace");
  if (opts.scope === "mine") return rows(mine);
  if (opts.scope === "shared") return rows(shared);
  if (opts.scope === "all" && can(a, "workspace:admin")) return rows(undefined);
  return rows(or(mine, shared));
}

async function find(a: Actor, id: string) {
  const me = who(a);
  const [row] = await rows(eq(jobs.id, z.uuid().parse(id)));
  if (!row || !canSeeJob(me, row)) throw new NotFoundError("That scheduled job doesn't exist.");
  return row;
}

export async function getJob(a: Actor, id: string) {
  assertCan(a, "records:read");
  return find(a, id);
}

async function assertRoom(scope: AgentScope, userId: string, name: string, exceptId?: string) {
  const db = await getDb();
  const others = await db
    .select({ name: jobs.name })
    .from(jobs)
    .where(and(eq(jobs.scope, scope), scope === "personal" ? eq(jobs.userId, userId) : undefined, exceptId ? ne(jobs.id, exceptId) : undefined));
  if (!exceptId && others.length >= MAX_JOBS) throw new ActionError(`That's ${MAX_JOBS} scheduled jobs, the most ${scope === "personal" ? "one teammate" : "a workspace"} can have. Delete one first.`);
  if (others.some((o) => o.name.toLowerCase() === name.toLowerCase())) throw new ActionError(`There's already a ${scope === "workspace" ? "shared " : ""}job called ${name}.`);
}

/** When a job runs next: never for an offer or a paused job. A one-time job in the past is refused. */
async function plan(scope: AgentScope, enabled: boolean, cadence: Cadence, now = new Date()) {
  if (scope === "workspace" || !enabled) return null;
  const { timezone } = await getWorkspace();
  const at = nextRun(cadence, now, timezone);
  if (!at) throw new ActionError("That time has already passed. Pick a later date.");
  return at;
}

export async function createJob(a: Actor, input: JobInput) {
  const user = assertCanChange(a);
  const data = jobInput.parse(input);
  const scope = data.scope ?? "personal";
  if (scope === "workspace") assertCan(a, "workspace:admin");
  await assertRoom(scope, user.id, data.name);
  const cadence = cleanCadence(data);
  const enabled = data.enabled ?? true;
  const db = await getDb();
  const [row] = await db
    .insert(jobs)
    .values({ scope, userId: user.id, name: data.name, prompt: data.request, ...cadence, enabled, nextRunAt: await plan(scope, enabled, cadence) })
    .returning();
  return { ...row, ownerName: user.name } satisfies JobRow;
}

export async function updateJob(a: Actor, id: string, patch: JobPatch) {
  assertCanChange(a);
  const current = await find(a, id);
  if (!canEditJob(who(a), current)) throw new ForbiddenError(current.scope === "workspace" ? "Shared jobs are managed by admins. Add it to your own jobs to change your copy." : "That job belongs to another teammate.");
  const data = jobPatch.parse(patch);
  if (data.scope && data.scope !== current.scope) throw new ActionError("A job can't be moved between yours and the team's. Share it from Settings instead, which offers the team a copy.");
  if (data.name && data.name.toLowerCase() !== current.name.toLowerCase()) await assertRoom(current.scope, current.userId, data.name, current.id);
  const cadence = cleanCadence({
    every: data.every ?? current.every,
    time: data.time ?? current.time,
    weekday: data.weekday === undefined ? current.weekday : data.weekday,
    monthDay: data.monthDay === undefined ? current.monthDay : data.monthDay,
    onDate: data.onDate === undefined ? current.onDate : data.onDate,
  });
  const enabled = data.enabled ?? current.enabled;
  const db = await getDb();
  const [row] = await db
    .update(jobs)
    .set({ name: data.name ?? current.name, prompt: data.request ?? current.prompt, ...cadence, enabled, nextRunAt: await plan(current.scope, enabled, cadence), ...(enabled ? { lastError: null } : {}) })
    .where(eq(jobs.id, current.id))
    .returning();
  return { ...row, ownerName: current.ownerName } satisfies JobRow;
}

export async function deleteJob(a: Actor, id: string) {
  assertCanChange(a);
  const current = await find(a, id);
  if (!canEditJob(who(a), current)) throw new ForbiddenError(current.scope === "workspace" ? "Shared jobs are managed by admins." : "That job belongs to another teammate.");
  const db = await getDb();
  await db.delete(jobs).where(eq(jobs.id, current.id));
  return current;
}

/** A teammate takes a job an admin offered: their own copy, which runs as them, at the offered time until they change it. */
export async function addSharedJob(a: Actor, id: string) {
  const user = assertCanChange(a);
  const offer = await find(a, id);
  if (offer.scope !== "workspace") throw new ActionError("That job isn't shared with the team.");
  const db = await getDb();
  const [mine] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.scope, "personal"), eq(jobs.userId, user.id), eq(jobs.fromId, offer.id)));
  if (mine) throw new ActionError(`${offer.name} is already one of your jobs.`);
  await assertRoom("personal", user.id, offer.name);
  const cadence = cleanCadence(offer);
  const [row] = await db
    .insert(jobs)
    .values({ scope: "personal", userId: user.id, name: offer.name, prompt: offer.prompt, ...cadence, enabled: true, nextRunAt: await plan("personal", true, cadence), fromId: offer.id })
    .returning();
  return { ...row, ownerName: user.name } satisfies JobRow;
}

/** An admin offers a job (their own or a teammate's) to the whole team, as a copy. The original keeps running for whoever has it. */
export async function shareJob(a: Actor, id: string) {
  const user = assertCanChange(a);
  assertCan(a, "workspace:admin");
  const source = await find(a, id);
  if (source.scope === "workspace") return source;
  await assertRoom("workspace", user.id, source.name);
  const db = await getDb();
  const [row] = await db
    .insert(jobs)
    .values({ scope: "workspace", userId: user.id, name: source.name, prompt: source.prompt, ...cleanCadence(source), enabled: true, nextRunAt: null })
    .returning();
  return { ...row, ownerName: user.name } satisfies JobRow;
}

// ─── Running ─────────────────────────────────────────────────────────────

/**
 * Starts a background run for a job, as its teammate. A job that can't start
 * (the month's budget is spent, their access changed) says why on the job
 * instead of failing the cron.
 */
async function fire(job: Job) {
  const db = await getDb();
  try {
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, job.userId));
    if (!user || user.deactivatedAt) throw new ActionError("Its teammate's account is deactivated.");
    const run = await startRun(await assistantActor(user), { prompt: job.prompt, title: job.name, source: "schedule", scheduleId: job.id });
    await db.update(jobs).set({ lastRunAt: new Date(), lastRunId: run.id, lastError: null }).where(eq(jobs.id, job.id));
    return run;
  } catch (err) {
    if (!(err instanceof ActionError)) console.error("[agent] scheduled job", job.id, err);
    const lastError = err instanceof ActionError ? err.message : "It couldn't start. It tries again at its next time.";
    await db.update(jobs).set({ lastRunAt: new Date(), lastError }).where(eq(jobs.id, job.id));
    return null;
  }
}

/** Runs one of the teammate's own jobs right now, without changing when it runs next. */
export async function runJobNow(a: Actor, id: string) {
  const user = assertCanChange(a);
  const job = await find(a, id);
  if (job.scope !== "personal" || job.userId !== user.id) throw new ActionError("Only your own jobs can be run. Add a shared job to yours first.");
  const run = await fire(job);
  if (!run) {
    const [after] = await rows(eq(jobs.id, job.id));
    throw new ActionError(after?.lastError ?? "It couldn't start. Try again in a moment.");
  }
  return run;
}

/**
 * From the agent cron: starts every job whose time has come. One conditional
 * update moves a job to its next time before it starts, so overlapping crons
 * run it once. A job whose time passed while the cron was down runs once,
 * then keeps to its cadence.
 */
export async function runDueJobs(now = new Date()) {
  if (!aiFeatures().background) return { started: 0 };
  const db = await getDb();
  const due = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.scope, "personal"), eq(jobs.enabled, true), isNotNull(jobs.nextRunAt), lte(jobs.nextRunAt, now)))
    .orderBy(asc(jobs.nextRunAt))
    .limit(200);
  if (!due.length) return { started: 0 };
  const { timezone } = await getWorkspace();
  let started = 0;
  for (const job of due) {
    const next = nextRun(job, now, timezone);
    const [claimed] = await db
      .update(jobs)
      // A one-time job is done once it has run.
      .set({ nextRunAt: next, enabled: next !== null })
      .where(and(eq(jobs.id, job.id), eq(jobs.enabled, true), eq(jobs.nextRunAt, job.nextRunAt!)))
      .returning();
    if (!claimed) continue;
    if (await fire(claimed)) started++;
  }
  return { started };
}
