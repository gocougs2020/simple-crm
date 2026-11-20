import "server-only";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { Client } from "eve/client";
import { z } from "zod";
import { appConfig } from "@/app.config";
import { getDb, schema } from "@/db";
import type { AgentMessage } from "@/db/schema";
import type { User } from "@/lib/auth";
import { featureInstructions } from "@/lib/api/features";
import { agentRunActive, type AgentRunSource } from "@/lib/constants";
import { assertCan, can, type Actor } from "@/lib/crm/actor";
import * as activities from "@/lib/crm/service/activities";
import { ActionError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { internalOrigin } from "@/lib/origin";
import { notify } from "@/lib/push/notify";
import { getWorkspace } from "@/lib/workspace";
import { assistantActor } from "./actor";
import { aiFeatures, aiOffMessage } from "./config";
import { markdownToHtml } from "./markdown";
import { MAX_STORED_CHARS } from "./messages";
import { budgetRefusal, budgetUsedUp, MAX_RUN_RESULT, promptLimit, monthStart, runFailure, runMessage, runTitle, usdToMicro, type RunRecord } from "./run-rules";
import { signRunToken, type RunClaims } from "./run-token";
import { cadenceLabel } from "./schedule-rules";
import { labelsSection } from "@/lib/crm/label-rules";
import { listLabels } from "@/lib/crm/labels";
import { skillsSection } from "./skill-rules";
import { activeSkills } from "./skills";

/**
 * The agent's background runs: long jobs it does for a teammate after
 * they've moved on (docs/AGENT.md). The work happens in the eve agent
 * (agent/), a separate service of this deployment. This file is the CRM's
 * side: it accepts a request, hands it to eve signed for one teammate, hears
 * back how it went, and puts the answer where the teammate asked for it.
 *
 * A run never has more access than the teammate: eve calls back into
 * /api/mcp with a token that names the run, and the CRM turns that into
 * "the teammate, via Agent" with their role at that moment.
 */

const runs = schema.agentRuns;
export type Run = typeof runs.$inferSelect;

const cfg = () => appConfig.agent.background;
const ACTIVE = ["queued", "running"] as const;

export type StartRunInput = {
  prompt: string;
  title?: string | null;
  source: AgentRunSource;
  threadId?: string | null;
  activityId?: string | null;
  personId?: string | null;
  organizationId?: string | null;
  clientId?: string | null;
  batchId?: string | null;
  /** The scheduled job that started it. */
  scheduleId?: string | null;
};

/**
 * Where eve's routes are mounted: this deployment, unless a separately started agent is named (development).
 * `origin` always comes from internalOrigin(), never from a request's Host header.
 */
const eveBaseUrl = (origin: string) => process.env.EVE_BASE_URL?.trim().replace(/\/$/, "") || origin;

/** Lets server-to-server calls reach a preview deployment behind Vercel's Deployment Protection. */
function protectionBypass(): Record<string, string> {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  return secret ? { "x-vercel-protection-bypass": secret } : {};
}

async function eveClient(claims: RunClaims) {
  return new Client({
    baseUrl: eveBaseUrl(claims.origin),
    auth: { bearer: async () => signRunToken("eve", claims, 300) },
    headers: protectionBypass(),
  });
}

/** This month's spend across the workspace, and how many runs this teammate has waiting or working. */
export async function budgetState(userId: string, now = new Date()) {
  const db = await getDb();
  const [[spent], [mine]] = await Promise.all([
    db
      .select({ total: sql<number>`coalesce(sum(${runs.costMicroUsd}), 0)::float8` })
      .from(runs)
      .where(gte(runs.createdAt, monthStart(now))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(runs)
      .where(and(eq(runs.userId, userId), inArray(runs.status, [...ACTIVE]))),
  ]);
  return { spentMicroUsd: Number(spent?.total ?? 0), active: mine?.n ?? 0 };
}

/** The teammate a request runs as: a signed-in teammate or their own key, never a workspace key, and never another run. */
function requester(actor: Actor): User {
  if (actor.kind !== "user") throw new ForbiddenError("Background work runs as one teammate, with their access. Use a personal key or a connected app, not a workspace key.");
  if (actor.runId) throw new ForbiddenError("A background task can't start another one.");
  // A run changes records as the teammate, so starting one needs edit access: a read-only role, key or connected app can't.
  assertCan(actor, "records:write");
  if (!aiFeatures().background) throw new ActionError(aiOffMessage("background"));
  return actor.user;
}

/** Throws, with a sentence, when this actor can't give the agent work right now. */
export async function assertCanStart(actor: Actor, wanted = 1) {
  const user = requester(actor);
  const refusal = budgetRefusal(await budgetState(user.id), wanted);
  if (refusal) throw new ActionError(refusal);
  return user;
}

function cleanPrompt(prompt: string, source: AgentRunSource) {
  const text = prompt.trim().slice(0, promptLimit(source));
  if (!text) throw new ActionError("Say what the agent should do.");
  return text;
}

/**
 * The first time a teammate gives the agent background work, their devices
 * start getting "The agent finished" (devices set up before this alert
 * existed don't have it). After that it's theirs to turn off in Settings.
 */
async function offerAlert(userId: string) {
  const db = await getDb();
  const [before] = await db.select({ id: runs.id }).from(runs).where(eq(runs.userId, userId)).limit(1);
  if (before) return;
  const subs = schema.pushSubscriptions;
  await db
    .update(subs)
    .set({ alerts: sql`${subs.alerts} || '["agent_done"]'::jsonb` })
    .where(and(eq(subs.userId, userId), sql`not ${subs.alerts} @> '["agent_done"]'::jsonb`));
}

/**
 * Accepts work for the agent and starts it if there's room; otherwise it
 * waits its turn. Returns the run as it stands.
 */
export async function startRun(actor: Actor, input: StartRunInput): Promise<Run> {
  const [run] = await startRuns(actor, [input]);
  return run;
}

/** Accepts several runs at once (a bulk request), all or none. */
export async function startRuns(actor: Actor, inputs: StartRunInput[]): Promise<Run[]> {
  if (!inputs.length) return [];
  const user = await assertCanStart(actor, inputs.length);
  const db = await getDb();
  await offerAlert(user.id);
  const rows = await db
    .insert(runs)
    .values(
      inputs.map((input) => {
        const prompt = cleanPrompt(input.prompt, input.source);
        return {
          userId: user.id,
          source: input.source,
          title: runTitle(input.title?.trim() || prompt),
          prompt,
          threadId: input.threadId ?? null,
          activityId: input.activityId ?? null,
          personId: input.personId ?? null,
          organizationId: input.organizationId ?? null,
          clientId: input.clientId ?? null,
          batchId: input.batchId ?? null,
          scheduleId: input.scheduleId ?? null,
        };
      }),
    )
    .returning();
  await pump(user.id);
  const fresh = await db
    .select()
    .from(runs)
    .where(
      inArray(
        runs.id,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(runs.createdAt));
  return fresh;
}

/**
 * The same job on each of several records: one run per record, sharing a
 * batch id, started a few at a time as earlier ones finish. Capped at
 * `maxBulkRecords` per request, on top of the per-run and monthly limits.
 */
export async function startBulk(
  actor: Actor,
  input: { request: string; entity: "person" | "organization" | "client"; ids: string[]; title?: string | null; threadId?: string | null },
) {
  const ids = [...new Set(input.ids)];
  if (ids.length > cfg().maxBulkRecords) {
    throw new ActionError(`That's ${ids.length} records, and ${cfg().maxBulkRecords} is the most one request can cover. Run it in parts, or an admin can raise agent.background.maxBulkRecords.`);
  }
  await assertCanStart(actor, ids.length);
  const db = await getDb();
  const names = new Map<string, string>();
  if (input.entity === "organization") {
    for (const r of await db.select({ id: schema.organizations.id, name: schema.organizations.name }).from(schema.organizations).where(inArray(schema.organizations.id, ids))) names.set(r.id, r.name);
  } else if (input.entity === "client") {
    for (const r of await db.select({ id: schema.clients.id, name: schema.clients.name }).from(schema.clients).where(inArray(schema.clients.id, ids))) names.set(r.id, r.name);
  } else {
    for (const r of await db.select({ id: schema.people.id, first: schema.people.firstName, last: schema.people.lastName }).from(schema.people).where(inArray(schema.people.id, ids))) names.set(r.id, [r.first, r.last].filter(Boolean).join(" "));
  }
  const missing = ids.filter((id) => !names.has(id));
  if (missing.length) throw new NotFoundError(`${missing.length === 1 ? "One of those records doesn't" : `${missing.length} of those records don't`} exist: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}.`);
  const batchId = crypto.randomUUID();
  const what = runTitle(input.title?.trim() || input.request, 60);
  const key = input.entity === "organization" ? "organizationId" : input.entity === "client" ? "clientId" : "personId";
  const started = await startRuns(
    actor,
    ids.map((id) => ({ prompt: input.request, title: `${names.get(id)}: ${what}`, source: "bulk" as const, batchId, threadId: input.threadId ?? null, [key]: id })),
  );
  return { batchId, runs: started };
}

/**
 * Starts this teammate's waiting runs, oldest first, while there's room and
 * budget. Called when a run is accepted, when one ends, and from the cron, so
 * a bulk request works through its list a few at a time.
 */
export async function pump(userId: string) {
  const db = await getDb();
  const origin = await internalOrigin();
  for (;;) {
    const [[working], [next], state] = await Promise.all([
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(runs)
        .where(and(eq(runs.userId, userId), eq(runs.status, "running"))),
      db
        .select()
        .from(runs)
        .where(and(eq(runs.userId, userId), eq(runs.status, "queued")))
        .orderBy(asc(runs.createdAt))
        .limit(1),
      budgetState(userId),
    ]);
    if (!next || (working?.n ?? 0) >= cfg().maxConcurrentPerUser) return;
    if (state.spentMicroUsd >= usdToMicro(cfg().monthlyBudgetUsd)) {
      // Nothing more starts this month: say so on everything still waiting.
      const stopped = await db
        .update(runs)
        .set({ status: "failed", error: budgetUsedUp(), finishedAt: new Date() })
        .where(and(eq(runs.userId, userId), eq(runs.status, "queued")))
        .returning();
      await Promise.all(stopped.map((r) => deliver(r).catch((err) => console.error("[agent] deliver", err))));
      return;
    }
    // One conditional update claims the run, so two requests can't both start it.
    const [claimed] = await db
      .update(runs)
      .set({ status: "running", startedAt: new Date() })
      .where(and(eq(runs.id, next.id), eq(runs.status, "queued")))
      .returning();
    if (!claimed) continue;
    // Two pumps can each count room for one more and claim different runs. Whoever started later steps back:
    // the runs that keep going are the first `maxConcurrentPerUser` by start time, so the limit holds.
    const going = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.userId, userId), eq(runs.status, "running")))
      .orderBy(asc(runs.startedAt), asc(runs.id));
    if (going.findIndex((r) => r.id === claimed.id) >= cfg().maxConcurrentPerUser) {
      await db
        .update(runs)
        .set({ status: "queued", startedAt: null })
        .where(and(eq(runs.id, claimed.id), eq(runs.status, "running")));
      return;
    }
    await dispatch(claimed, origin);
  }
}

async function recordOf(run: Pick<Run, "personId" | "organizationId" | "clientId">): Promise<RunRecord | null> {
  const db = await getDb();
  if (run.clientId) {
    const [c] = await db.select({ name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.id, run.clientId));
    if (c) return { entity: "client", id: run.clientId, name: c.name };
  }
  if (run.personId) {
    const [p] = await db.select({ first: schema.people.firstName, last: schema.people.lastName }).from(schema.people).where(eq(schema.people.id, run.personId));
    if (p) return { entity: "person", id: run.personId, name: [p.first, p.last].filter(Boolean).join(" ") };
  }
  if (run.organizationId) {
    const [o] = await db.select({ name: schema.organizations.name }).from(schema.organizations).where(eq(schema.organizations.id, run.organizationId));
    if (o) return { entity: "organization", id: run.organizationId, name: o.name };
  }
  return null;
}

async function userOf(userId: string) {
  const db = await getDb();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  return user && !user.deactivatedAt ? user : null;
}

/** Hands a claimed run to eve. A run that can't start is marked failed with a sentence. */
async function dispatch(run: Run, origin: string) {
  const db = await getDb();
  try {
    const user = await userOf(run.userId);
    if (!user) throw new Error("the teammate was deactivated");
    const actor = await assistantActor(user);
    const [workspace, record, activity, skills, job] = await Promise.all([
      getWorkspace(),
      recordOf(run),
      run.activityId
        ? db
            .select({ id: schema.activities.id, type: schema.activities.type, subject: schema.activities.subject })
            .from(schema.activities)
            .where(eq(schema.activities.id, run.activityId))
            .then((r) => r[0] ?? null)
        : null,
      activeSkills(user.id),
      run.scheduleId
        ? db
            .select()
            .from(schema.agentSchedules)
            .where(eq(schema.agentSchedules.id, run.scheduleId))
            .then((r) => r[0] ?? null)
        : null,
    ]);
    const message = runMessage({
      user,
      canWrite: can(actor, "records:write"),
      workspace: { name: workspace.name, timezone: workspace.timezone, currency: workspace.currency },
      now: new Date(),
      source: run.source,
      record,
      activity: activity && (activity.type === "note" || activity.type === "task") ? { id: activity.id, type: activity.type, subject: activity.subject } : null,
      knowledge: featureInstructions(),
      labels: labelsSection(await listLabels()),
      skills: skillsSection(skills, { tool: "crm__get_skill", owner: user.name }),
      schedule: job ? { name: job.name, cadence: cadenceLabel(job) } : null,
      prompt: run.prompt,
    });
    const client = await eveClient({ userId: user.id, runId: run.id, origin });
    const { session } = await client.sessions.create({ message, signal: AbortSignal.timeout(30_000) });
    await db.update(runs).set({ sessionId: session.id }).where(eq(runs.id, run.id));
  } catch (err) {
    console.error("[agent] run didn't start", run.id, err);
    const [failed] = await db
      .update(runs)
      .set({ status: "failed", error: "The agent's background worker didn't answer, so this never started. Try again in a moment.", finishedAt: new Date() })
      .where(and(eq(runs.id, run.id), eq(runs.status, "running")))
      .returning();
    if (failed) await deliver(failed).catch((e) => console.error("[agent] deliver", e));
  }
}

// ─── Hearing back from eve ───────────────────────────────────────────────

export const runReport = z.object({
  status: z.enum(["done", "failed", "cancelled"]),
  result: z.string().max(400_000).optional(),
  error: z.string().max(4_000).optional(),
  sessionId: z.string().max(200).optional(),
  usage: z
    .object({
      costUsd: z.number().min(0).max(10_000).nullable().optional(),
      inputTokens: z.number().int().min(0).optional(),
      outputTokens: z.number().int().min(0).optional(),
    })
    .optional(),
});
export type RunReport = z.infer<typeof runReport>;

/**
 * Records how a run went, from the agent's report hook (agent/hooks/report.ts).
 * Spend is always recorded. A run that's already final keeps its outcome,
 * except that a real failure replaces "cancelled" when nobody cancelled it
 * (eve ends a failed session's turn as cancelled first).
 */
export async function applyReport(claims: RunClaims, report: RunReport) {
  const db = await getDb();
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, claims.runId), eq(runs.userId, claims.userId)));
  if (!run) throw new NotFoundError("That run doesn't exist.");
  const spend = {
    costMicroUsd: Math.max(run.costMicroUsd, usdToMicro(report.usage?.costUsd ?? 0)),
    inputTokens: Math.max(run.inputTokens, report.usage?.inputTokens ?? 0),
    outputTokens: Math.max(run.outputTokens, report.usage?.outputTokens ?? 0),
  };
  const upgrade = run.status === "cancelled" && !run.error && report.status === "failed";
  if (!agentRunActive(run.status) && !upgrade) {
    await db.update(runs).set(spend).where(eq(runs.id, run.id));
    return;
  }
  if (report.status === "failed") console.error("[agent] run failed", run.id, report.error);
  const outcome =
    report.status === "done"
      ? { status: "done" as const, result: (report.result?.trim() || "It finished without writing an answer.").slice(0, MAX_RUN_RESULT), error: null }
      : report.status === "failed"
        ? { status: "failed" as const, error: runFailure(report.error) }
        : { status: "cancelled" as const };
  const [updated] = await db
    .update(runs)
    .set({ ...spend, ...outcome, finishedAt: new Date(), ...(report.sessionId && !run.sessionId ? { sessionId: report.sessionId } : {}) })
    .where(and(eq(runs.id, run.id), eq(runs.status, run.status)))
    .returning();
  if (!updated) return;
  // A cancelled turn may still be followed by the session's failure; only say so once it's settled either way.
  if (updated.status !== "cancelled") await deliver(updated).catch((err) => console.error("[agent] deliver", err));
  await pump(run.userId).catch((err) => console.error("[agent] pump", err));
}

// ─── Putting the answer where it was asked for ───────────────────────────

const recordUrl = (run: Pick<Run, "personId" | "organizationId" | "clientId">) =>
  run.clientId ? `/clients/${run.clientId}` : run.personId ? `/people/${run.personId}` : run.organizationId ? `/organizations/${run.organizationId}` : null;

/** The message a finished run leaves in the chat it was started from. */
function threadMessage(run: Run): AgentMessage {
  const text = run.status === "done" ? `**Finished in the background:** ${run.title}\n\n${run.result ?? ""}` : `**Couldn't finish in the background:** ${run.title}\n\n${run.error ?? ""}`;
  return { id: `run-${run.id}`, role: "assistant", parts: [{ type: "text", text: text.trim() }], metadata: { createdAt: Date.now(), runId: run.id } };
}

/** One message for a whole bulk request, once its last record is done: each record with how it went. */
async function batchMessage(batchId: string): Promise<AgentMessage> {
  const db = await getDb();
  const all = await db.select().from(runs).where(eq(runs.batchId, batchId)).orderBy(asc(runs.createdAt));
  const done = all.filter((r) => r.status === "done").length;
  const firstLine = (text: string | null) => (text ?? "").split("\n").find((l) => l.trim())?.replace(/^[#*\s-]+/, "").slice(0, 200) ?? "";
  const lines = all.map((r) => {
    const url = recordUrl(r);
    const name = r.title.split(": ")[0];
    return `- ${url ? `[${name}](${url})` : name}: ${r.status === "done" ? firstLine(r.result) : (r.error ?? "Cancelled.")}`;
  });
  const text = `**Bulk request finished:** ${done} of ${all.length} done.\n\n${lines.join("\n")}`;
  return { id: `run-batch-${batchId}`, role: "assistant", parts: [{ type: "text", text }], metadata: { createdAt: Date.now(), batchId } };
}

/** Adds the run's answer to its chat thread, once, without touching the rest of the thread. A bulk request posts one summary when its last record is done. */
async function postToThread(run: Run, opts: { batchDone?: boolean } = {}) {
  if (!run.threadId) return;
  if (run.batchId && !opts.batchDone) return;
  const db = await getDb();
  const t = schema.agentThreads;
  const message = run.batchId ? await batchMessage(run.batchId) : threadMessage(run);
  await db
    .update(t)
    .set({ messages: sql`${t.messages} || ${JSON.stringify([message])}::jsonb`, updatedAt: new Date(), lastMessageAt: new Date() })
    .where(
      and(
        eq(t.id, run.threadId),
        eq(t.userId, run.userId),
        sql`not ${t.messages} @> ${JSON.stringify([{ id: message.id }])}::jsonb`,
        // A thread near its size limit keeps its conversation; the answer is still on the run.
        sql`length(${t.messages}::text) < ${MAX_STORED_CHARS}`,
      ),
    );
}

/** The answer as a reply under the note a mention came from, or added to the task that was assigned. */
async function postToActivity(run: Run) {
  if (!run.activityId || (run.source !== "mention" && run.source !== "task")) return;
  const user = await userOf(run.userId);
  if (!user) return;
  const actor = await assistantActor(user);
  if (!can(actor, "records:write")) return;
  const db = await getDb();
  const [source] = await db.select().from(schema.activities).where(eq(schema.activities.id, run.activityId));
  if (!source) return;
  // The task was handed over again since this run started: the newer run answers it, not this one.
  if (source.agentRunId && source.agentRunId !== run.id) return;
  const answer = run.status === "done" ? markdownToHtml(run.result ?? "") : `<p>${run.error ?? ""}</p>`;
  if (source.type === "task") {
    const heading = `<p><strong>${appConfig.agent.name}${run.status === "done" ? "" : " couldn't finish"}:</strong></p>`;
    await activities.updateActivity(actor, source.id, { body: `${source.body ?? ""}${heading}${answer}` });
    if (run.status === "done" && !source.completedAt) await activities.setCompleted(actor, source.id, true);
    return;
  }
  // The answer is the agent's own writing: it never hands work back to itself, whatever the text says.
  await activities.replyToNote(actor, source.id, { body: run.status === "done" ? answer : `<p><strong>${appConfig.agent.name} couldn't finish.</strong></p>${answer}` }, { handOff: false });
}

/** Emails the answer back to whoever forwarded the email (src/lib/forwarding/inbound.ts). */
async function postToEmail(run: Run) {
  if (run.source !== "email") return;
  const { deliverForwardReply } = await import("@/lib/forwarding/inbound");
  await deliverForwardReply(run);
}

/** Saves a final run's answer where the teammate asked for it and tells them it's ready. */
async function deliver(run: Run) {
  await Promise.all([
    postToThread(run).catch((err) => console.error("[agent] thread", err)),
    postToActivity(run).catch((err) => console.error("[agent] activity", err)),
    postToEmail(run).catch((err) => console.error("[agent] email", err)),
  ]);
  // One notification for a bulk request, when its last record is done, instead of one per record.
  if (run.batchId) {
    const db = await getDb();
    const [left] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(runs)
      .where(and(eq(runs.batchId, run.batchId), inArray(runs.status, [...ACTIVE])));
    if (left?.n) return;
    await postToThread(run, { batchDone: true }).catch((err) => console.error("[agent] thread", err));
    notify([run.userId], { kind: "agent_done", title: `${appConfig.agent.name} finished a bulk request`, body: run.title, url: "/?agent=tasks", dedupeKey: `agent_done:batch:${run.batchId}` });
    return;
  }
  notify([run.userId], {
    kind: "agent_done",
    title: run.status === "done" ? `${appConfig.agent.name} finished` : `${appConfig.agent.name} couldn't finish`,
    body: run.title,
    url: recordUrl(run) ?? "/?agent=tasks",
    dedupeKey: `agent_done:${run.id}`,
  });
}

// ─── Reading and cancelling ──────────────────────────────────────────────

/** A teammate sees their own runs; admins can open anyone's. */
async function visibleRun(actor: Actor, runId: string) {
  if (actor.kind !== "user") throw new ForbiddenError("Background work belongs to a teammate. Use a personal key or a connected app.");
  const db = await getDb();
  const [run] = await db
    .select()
    .from(runs)
    .where(eq(runs.id, z.uuid().parse(runId)));
  if (!run || (run.userId !== actor.user.id && !can(actor, "workspace:admin"))) throw new NotFoundError("That background task doesn't exist.");
  return run;
}

export const getRun = (actor: Actor, runId: string) => visibleRun(actor, runId);

export async function listRuns(actor: Actor, opts: { active?: boolean; batchId?: string; limit?: number } = {}) {
  if (actor.kind !== "user") throw new ForbiddenError("Background work belongs to a teammate. Use a personal key or a connected app.");
  assertCan(actor, "records:read");
  const db = await getDb();
  return db
    .select()
    .from(runs)
    .where(and(eq(runs.userId, actor.user.id), opts.active ? inArray(runs.status, [...ACTIVE]) : undefined, opts.batchId ? eq(runs.batchId, opts.batchId) : undefined))
    .orderBy(desc(runs.createdAt))
    .limit(Math.min(opts.limit ?? 30, 100));
}

/** Finished tasks nobody has looked at stay listable this long. */
const PANEL_KEEP_MS = 7 * 86_400_000;

/**
 * The teammate's tasks as the agent panel lists them: everything still going, and what finished
 * and hasn't left the list yet. With `seen` (the panel is open), a finished task starts its
 * `agent.background.clearAfterMinutes`, so it goes on its own once they've had the chance to read it,
 * however long after it finished they came back.
 */
export async function listPanelRuns(actor: Actor, opts: { seen?: boolean } = {}) {
  if (actor.kind !== "user") throw new ForbiddenError("Background work belongs to a teammate. Use a personal key or a connected app.");
  assertCan(actor, "records:read");
  const db = await getDb();
  const now = new Date();
  const rows = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.userId, actor.user.id),
        or(inArray(runs.status, [...ACTIVE]), gt(runs.hideAt, now), and(isNull(runs.hideAt), or(isNull(runs.finishedAt), gt(runs.finishedAt, new Date(now.getTime() - PANEL_KEEP_MS))))),
      ),
    )
    .orderBy(desc(runs.createdAt))
    .limit(100);
  const fresh = opts.seen ? rows.filter((r) => !agentRunActive(r.status) && !r.hideAt).map((r) => r.id) : [];
  if (fresh.length) {
    const hideAt = new Date(now.getTime() + appConfig.agent.background.clearAfterMinutes * 60_000);
    await db
      .update(runs)
      .set({ hideAt, updatedAt: sql`${runs.updatedAt}` })
      .where(and(inArray(runs.id, fresh), isNull(runs.hideAt), notInArray(runs.status, [...ACTIVE])));
    return rows.map((r) => (fresh.includes(r.id) ? { ...r, hideAt } : r));
  }
  return rows;
}

/**
 * Takes the teammate's tasks off the panel's list: the ones named, or every finished one. A task
 * still going is stopped first (what it changed stays). The runs are kept: this only tidies the list.
 */
export async function clearPanelRuns(actor: Actor, opts: { ids?: string[]; batchId?: string } = {}) {
  if (actor.kind !== "user") throw new ForbiddenError("Background work belongs to a teammate. Use a personal key or a connected app.");
  assertCan(actor, "records:read");
  const db = await getDb();
  const mine = eq(runs.userId, actor.user.id);
  const named = opts.ids?.length ? inArray(runs.id, opts.ids) : opts.batchId ? eq(runs.batchId, opts.batchId) : undefined;
  if (opts.ids?.length) {
    const going = await db.select({ id: runs.id }).from(runs).where(and(mine, named, inArray(runs.status, [...ACTIVE])));
    for (const r of going) await cancelRun(actor, r.id);
  } else if (opts.batchId) {
    // All at once: stopping them one by one would let each stop start the next one waiting in the same request.
    const going = await db.select({ id: runs.id }).from(runs).where(and(mine, named, inArray(runs.status, [...ACTIVE]))).limit(1);
    if (going.length) await cancelBatch(actor, opts.batchId);
  }
  const now = new Date();
  const cleared = await db
    .update(runs)
    .set({ hideAt: now, updatedAt: sql`${runs.updatedAt}` })
    .where(and(mine, named, notInArray(runs.status, [...ACTIVE]), or(isNull(runs.hideAt), gt(runs.hideAt, now))))
    .returning({ id: runs.id });
  return { cleared: cleared.length };
}

async function stopSession(run: Run) {
  if (!run.sessionId) return;
  try {
    const client = await eveClient({ userId: run.userId, runId: run.id, origin: await internalOrigin() });
    await client.sessions.attach(run.sessionId).cancel({ signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    console.error("[agent] cancel", run.id, err);
  }
}

/** Stops a run. What it already changed stays, and is in history. */
export async function cancelRun(actor: Actor, runId: string) {
  assertCan(actor, "records:write");
  const run = await visibleRun(actor, runId);
  if (!agentRunActive(run.status)) return run;
  const db = await getDb();
  const [cancelled] = await db
    .update(runs)
    .set({ status: "cancelled", error: "Cancelled before it finished. What it changed so far is in the record's history.", finishedAt: new Date() })
    .where(and(eq(runs.id, run.id), inArray(runs.status, [...ACTIVE])))
    .returning();
  if (!cancelled) return visibleRun(actor, runId);
  await stopSession(run);
  await pump(run.userId).catch((err) => console.error("[agent] pump", err));
  return cancelled;
}

/**
 * Stops an earlier run for the same note or task when it's handed over again
 * (a task edited and given back, say), so only the newest run works on it.
 * A teammate can replace their own run; replacing someone else's takes an
 * admin, the same rule as stopping a run. Otherwise it's refused, with who to ask.
 */
export async function supersedeRuns(actor: Actor, activityId: string, opts: { check?: boolean } = {}) {
  if (actor.kind !== "user") return;
  const db = await getDb();
  const going = await db
    .select({ run: runs, owner: schema.users.name })
    .from(runs)
    .innerJoin(schema.users, eq(schema.users.id, runs.userId))
    .where(and(eq(runs.activityId, activityId), inArray(runs.status, [...ACTIVE])));
  const theirs = going.find((g) => g.run.userId !== actor.user.id);
  if (theirs && !can(actor, "workspace:admin")) {
    throw new ActionError(`${appConfig.agent.name} is already working on this for ${theirs.owner}. Wait for it to finish, or ask them or an admin to stop it.`);
  }
  if (opts.check || !going.length) return;
  const stopped = await db
    .update(runs)
    .set({ status: "cancelled", error: "Stopped because the task was handed over again. The newer run answers it.", finishedAt: new Date() })
    .where(
      and(
        inArray(
          runs.id,
          going.map((g) => g.run.id),
        ),
        inArray(runs.status, [...ACTIVE]),
      ),
    )
    .returning();
  await Promise.all(stopped.map((run) => stopSession(run)));
}

/** Stops everything still waiting or working in one bulk request. */
export async function cancelBatch(actor: Actor, batchId: string) {
  assertCan(actor, "records:write");
  if (actor.kind !== "user") throw new ForbiddenError("Background work belongs to a teammate. Use a personal key or a connected app.");
  const db = await getDb();
  const stopped = await db
    .update(runs)
    .set({ status: "cancelled", error: "Cancelled before it finished. What it changed so far is in the record's history.", finishedAt: new Date() })
    .where(and(eq(runs.batchId, z.uuid().parse(batchId)), eq(runs.userId, actor.user.id), inArray(runs.status, [...ACTIVE])))
    .returning();
  await Promise.all(stopped.map((run) => stopSession(run)));
  return { stopped: stopped.length };
}

/**
 * The safety net, from the cron: stops runs that have gone on too long, and
 * starts anything left waiting (a report that never arrived, say).
 */
export async function sweepRuns(now = new Date()) {
  if (!aiFeatures().background) return { stopped: 0 };
  const db = await getDb();
  const tooLong = new Date(now.getTime() - cfg().maxRunMinutes * 60_000);
  const stale = await db
    .select()
    .from(runs)
    .where(and(eq(runs.status, "running"), lt(runs.startedAt, tooLong)));
  for (const run of stale) {
    const [failed] = await db
      .update(runs)
      .set({ status: "failed", error: runFailure("timed out"), finishedAt: now })
      .where(and(eq(runs.id, run.id), eq(runs.status, "running")))
      .returning();
    if (!failed) continue;
    await stopSession(run);
    await deliver(failed).catch((err) => console.error("[agent] deliver", err));
  }
  const waiting = await db.selectDistinct({ userId: runs.userId }).from(runs).where(eq(runs.status, "queued"));
  for (const { userId } of waiting) await pump(userId).catch((err) => console.error("[agent] pump", err));
  return { stopped: stale.length };
}
