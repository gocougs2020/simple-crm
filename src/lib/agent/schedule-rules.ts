import { z } from "zod";
import { agentScopes, scheduleEvery, type AgentScope, type ScheduleEvery } from "@/lib/constants";
import { dayKey, zonedTime } from "@/lib/format";

/**
 * The rules for the agent's scheduled jobs. Pure (tested): what a job may
 * hold, when it runs next, and how its cadence reads. The database side and
 * the cron are in schedules.ts.
 *
 * Jobs run from the agent cron, on the quarter hour (docs/ARCHITECTURE.md,
 * Background jobs), so times are on the quarter hour and the most often a job
 * can run is once a day.
 */

export const MAX_JOB_NAME = 80;
export const MAX_JOB_REQUEST = 4_000;
/** Jobs one teammate can have, and offers the workspace can have. */
export const MAX_JOBS = 20;

export type Cadence = { every: ScheduleEvery; time: string; weekday?: number | null; monthDay?: number | null; onDate?: string | null };

const time = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):(00|15|30|45)$/, "Pick a time on the quarter hour, like 08:00 or 14:30.");
const date = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Write the date as YYYY-MM-DD.")
  .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "That date doesn't exist.");

const jobFields = {
  name: z.string().trim().min(1, "Name the job.").max(MAX_JOB_NAME, `Keep the name under ${MAX_JOB_NAME} characters.`).describe('A short name, like "Monday pipeline review".'),
  request: z
    .string()
    .trim()
    .min(1, "Say what the agent should do each time.")
    .max(MAX_JOB_REQUEST, `Keep the request under ${MAX_JOB_REQUEST.toLocaleString("en-US")} characters.`)
    .describe("What to do each time it runs, in plain words, with everything the agent needs. It runs in the background and can't ask questions."),
  every: z.enum(scheduleEvery).describe("How often: day, weekday (Monday to Friday), week, month, or once."),
  time: time.describe('The time of day in the workspace time zone, 24-hour "HH:MM", on the quarter hour: "08:00", "14:30".'),
  weekday: z.coerce.number().int().min(1).max(7).nullish().describe("For every: week. 1 is Monday, 7 is Sunday."),
  monthDay: z.coerce.number().int().min(1).max(28).nullish().describe("For every: month. The day of the month, 1 to 28."),
  onDate: date.nullish().describe("For every: once. The date it runs, YYYY-MM-DD."),
  scope: z.enum(agentScopes).optional().describe("personal (the default): runs for this teammate. workspace (offered to the whole team) can only be set by an admin in Settings."),
  enabled: z.boolean().optional().describe("false pauses the job."),
};

const cadenceIssue = (c: Partial<Cadence>): string | null =>
  c.every === "week" && !c.weekday ? "Pick the day of the week." : c.every === "month" && !c.monthDay ? "Pick the day of the month, 1 to 28." : c.every === "once" && !c.onDate ? "Pick the date." : null;

export const jobInput = z.object(jobFields).superRefine((v, ctx) => {
  const issue = cadenceIssue(v);
  if (issue) ctx.addIssue({ code: "custom", message: issue, path: [v.every === "week" ? "weekday" : v.every === "month" ? "monthDay" : "onDate"] });
});
export type JobInput = z.infer<typeof jobInput>;
export const jobPatch = z.object(jobFields).partial();
export type JobPatch = z.infer<typeof jobPatch>;

/** A cadence with only the fields its `every` uses, checked. Throws a ZodError with a sentence when one is missing. */
export function cleanCadence(c: Cadence): Required<Cadence> {
  const issue = cadenceIssue(c);
  if (issue) throw new z.ZodError([{ code: "custom", message: issue, path: [], input: c }]);
  return { every: c.every, time: time.parse(c.time), weekday: c.every === "week" ? c.weekday! : null, monthDay: c.every === "month" ? c.monthDay! : null, onDate: c.every === "once" ? c.onDate! : null };
}

/** 1 (Monday) to 7 (Sunday) for a calendar day. */
const weekdayOf = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay() || 7;
const addDays = (ymd: string, days: number) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/**
 * The next time a job runs after `after`, in the workspace's time zone, or
 * null when it never will (a one-time job whose time has passed).
 */
export function nextRun(c: Cadence, after: Date, tz: string): Date | null {
  if (c.every === "once") {
    if (!c.onDate) return null;
    const at = zonedTime(c.onDate, c.time, tz);
    return at.getTime() > after.getTime() ? at : null;
  }
  const today = dayKey(after, tz);
  // A month at most between runs, plus slack for the day the search starts on.
  for (let i = 0; i <= 62; i++) {
    const day = addDays(today, i);
    const w = weekdayOf(day);
    const fits = c.every === "day" || (c.every === "weekday" && w <= 5) || (c.every === "week" && w === c.weekday) || (c.every === "month" && Number(day.slice(8)) === c.monthDay);
    if (!fits) continue;
    const at = zonedTime(day, c.time, tz);
    if (at.getTime() > after.getTime()) return at;
  }
  return null;
}

const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** "08:00" → "8:00 AM". */
export function clockLabel(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** "Every weekday at 8:00 AM", "Every Monday at 9:30 AM", "On the 1st of each month at 7:00 AM", "Once, on 2026-12-01 at 2:00 PM". */
export function cadenceLabel(c: Cadence) {
  const at = `at ${clockLabel(c.time)}`;
  if (c.every === "day") return `Every day ${at}`;
  if (c.every === "weekday") return `Every weekday ${at}`;
  if (c.every === "week") return `Every ${weekdays[(c.weekday ?? 1) - 1]} ${at}`;
  if (c.every === "month") return `On the ${ordinal(c.monthDay ?? 1)} of each month ${at}`;
  return `Once, on ${c.onDate ?? "a date"} ${at}`;
}

type Who = { id: string; admin: boolean };
type Owned = { scope: AgentScope; userId: string };

/** A teammate sees their own jobs and the ones offered to the team; admins see everyone's. */
export const canSeeJob = (who: Who, j: Owned) => j.scope === "workspace" || j.userId === who.id || who.admin;
/** A teammate changes their own; offers, and other teammates' jobs, take an admin. */
export const canEditJob = (who: Who, j: Owned) => who.admin || (j.scope === "personal" && j.userId === who.id);
