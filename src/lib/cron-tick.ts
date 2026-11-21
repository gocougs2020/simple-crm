import "server-only";
import { sql } from "drizzle-orm";
import { appConfig } from "@/app.config";
import { getDb, schema } from "@/db";
import { aiFeatures } from "@/lib/agent/config";
import { sweepRuns } from "@/lib/agent/runs";
import { runDueJobs } from "@/lib/agent/schedules";
import { pruneDaily } from "@/lib/daily-prune";
import { getResend } from "@/lib/email";
import { runDueCampaigns, STALE_SEND_MS } from "@/lib/email/campaigns";
import { syncAllInboxes } from "@/lib/email/inbox";
import { describeBacklog } from "@/lib/file-describe";
import { retryReplies } from "@/lib/forwarding/inbound";
import { microsoftConfigured } from "@/lib/microsoft/config";
import { microsoftSlotDue, syncAllMailboxes } from "@/lib/microsoft/sync-all";
import { sendAgendaEmails } from "@/lib/notifications/agenda";
import { GRACE_MS, isMorning, LEAD_MS } from "@/lib/notifications/schedule";
import { siteOrigin } from "@/lib/origin";
import { sendDueNotifications } from "@/lib/push/due";
import { pushConfigured } from "@/lib/push/vapid";

/** Stop starting jobs after this, so the run finishes inside the route's maxDuration (300 s). What's left runs next time. */
const BUDGET_MS = 240_000;
/** The daily prune runs in this quarter-hour slot (UTC), with the Stripe sync, when the database is awake anyway. */
const PRUNE_SLOT = 9 * 60;

/** Which quarter hour of the UTC day a time falls in, in minutes (the crons fire at :00, :15, :30, :45). */
export const quarterHour = (now: Date) => (Math.round((now.getUTCHours() * 60 + now.getUTCMinutes()) / 15) * 15) % (24 * 60);

type Due = { campaigns: boolean; jobs: boolean; runs: boolean; files: boolean; replies: boolean; timed: boolean; devices: boolean; digests: boolean; tz: string | null };

/**
 * Whether anything is waiting, for each job, in one statement, so a quarter
 * hour with nothing to do costs one query and no writes. Each condition is
 * the one its job selects on (runDueCampaigns, runDueJobs, sweepRuns,
 * describeBacklog and embedBacklog, retryReplies, sendDueNotifications,
 * sendAgendaEmails); the job checks again itself.
 */
export async function whatIsDue(now = new Date()): Promise<Due> {
  const db = await getDb();
  const { campaigns: c, agentSchedules: j, agentRuns: r, files: f, emailForwards: fw, users: u, activities: a, pushSubscriptions: s } = schema;
  const tooLong = new Date(now.getTime() - appConfig.agent.background.maxRunMinutes * 60_000);
  const files = aiFeatures().files
    ? sql`exists (select 1 from ${f} where ${f.deletedAt} is null and ((${f.describeStatus} is null and ${f.descriptionBy} is null and (${f.describeStartedAt} is null or ${f.describeStartedAt} < now() - interval '5 minutes')) or (${f.description} is not null and ${f.embedding} is null)))`
    : sql`false`;
  const result = await db.execute(sql`select
    exists (select 1 from ${c} where (${c.status} = 'scheduled' and ${c.scheduledAt} <= ${now}) or (${c.status} = 'sending' and ${c.updatedAt} < ${new Date(now.getTime() - STALE_SEND_MS)})) as campaigns,
    exists (select 1 from ${j} where ${j.scope} = 'personal' and ${j.enabled} and ${j.nextRunAt} <= ${now}) as jobs,
    exists (select 1 from ${r} where ${r.status} = 'queued' or (${r.status} = 'running' and ${r.startedAt} < ${tooLong})) as runs,
    ${files} as files,
    exists (select 1 from ${fw} join ${r} on ${r.id} = ${fw.runId} join ${u} on ${u.id} = ${fw.userId} where ${fw.status} in ('answered', 'failed') and ${fw.repliedAt} is null and ${r.status} in ('done', 'failed', 'cancelled') and ${fw.receivedAt} >= ${new Date(now.getTime() - 86_400_000)} and ${u.deactivatedAt} is null) as replies,
    exists (select 1 from ${a} where ${a.completedAt} is null and ${a.dueHasTime} and ${a.assigneeId} is not null and ${a.dueAt} > ${new Date(now.getTime() - GRACE_MS)} and ${a.dueAt} <= ${new Date(now.getTime() + LEAD_MS)}) as timed,
    exists (select 1 from ${s}) as devices,
    exists (select 1 from ${u} where ${u.deactivatedAt} is null and ${u.passwordHash} is not null and ${u.prefs}->'emailDigests' is not null) as digests,
    (select ${schema.workspace.timezone} from ${schema.workspace} limit 1) as tz`);
  const [row] = (result as unknown as { rows?: Due[] }).rows ?? (result as unknown as Due[]);
  return row;
}

/**
 * The one quarter-hour cron (/api/cron/tick): asks what's due in one query,
 * then runs only the jobs that have work, each on its own so one failing
 * doesn't stop the rest. The inbox sync (a safety net behind Resend's
 * webhook) runs hourly; Microsoft 365 on `microsoft.syncEveryMinutes`; the
 * daily prune once a day. Each job's own route still works on its own.
 */
export async function tick(now = new Date()) {
  const started = Date.now();
  const due = await whatIsDue(now);
  const slot = quarterHour(now);
  const tz = due.tz ?? "UTC";
  const ran: Record<string, unknown> = {};
  const step = async (name: string, when: boolean, work: () => Promise<unknown>) => {
    if (!when) return;
    if (Date.now() - started > BUDGET_MS) return void (ran[name] = { deferred: "Out of time this run; it goes next time." });
    try {
      ran[name] = await work();
    } catch (err) {
      console.error(`[cron tick] ${name}`, err);
      ran[name] = { error: err instanceof Error ? err.message : String(err) };
    }
  };
  const morning = isMorning(now, tz);
  const background = aiFeatures().background;

  // Time-sensitive first: reminders and scheduled sends.
  await step("notifications", (due.timed || (morning && due.devices)) && (await pushConfigured()), () => sendDueNotifications(now));
  await step("agenda", morning && due.digests, () => sendAgendaEmails(now));
  await step("campaigns", due.campaigns, async () => runDueCampaigns(await siteOrigin()));
  await step("scheduledJobs", background && due.jobs, () => runDueJobs(now));
  await step("runs", background && due.runs, () => sweepRuns(now));
  await step("forwardReplies", due.replies, () => retryReplies(now));
  await step("files", due.files, () => describeBacklog());
  await step("inbox", slot % 60 === 0 && !!getResend(), () => syncAllInboxes(25));
  await step("microsoft", microsoftConfigured() && microsoftSlotDue(now), () => syncAllMailboxes({ budgetMs: Math.max(0, BUDGET_MS - (Date.now() - started)) }));
  await step("prune", slot === PRUNE_SLOT, () => pruneDaily(now));
  return { at: now.toISOString(), due, ran };
}
