import { appConfig } from "@/app.config";
import { roleLabels, type AgentRunSource, type UserRole } from "@/lib/constants";
import { isDestructive, type Operation } from "@/lib/api/spec";
import { localNow } from "./prompt";

/**
 * The rules for the agent's background runs. Pure (tested): what a run
 * may do, what it's told, and how its spend is counted. The database and eve
 * calls are in runs.ts.
 */

/** What the teammate asked for, at most. Longer requests are cut here. */
export const MAX_RUN_PROMPT = 8_000;
/** A stored answer, at most. */
export const MAX_RUN_RESULT = 60_000;

/** A short name for a run, from its request: the first line, trimmed to fit a list. */
export function runTitle(prompt: string, max = 80) {
  const line = prompt.replace(/\s+/g, " ").trim();
  if (!line) return "Background task";
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The tools a background run gets out of the ones its teammate's role allows.
 * Nobody is watching a run, so it can't archive, delete or merge (those wait
 * for a confirm button in chat), and it can't start more runs of itself.
 * It can read skills and scheduled jobs but not write them: what a run reads
 * on the web or in a record must never become standing instructions or
 * recurring work.
 */
const STANDING_TAGS = new Set(["Skills", "Scheduled jobs"]);
/** Saves or changes a skill or a scheduled job: something the agent will act on later, with nobody asking. */
export const writesStanding = (op: Pick<Operation, "method" | "tag">) => STANDING_TAGS.has(op.tag) && op.method !== "GET";
export const runMayUse = (op: Pick<Operation, "method" | "destructive" | "tag">) => !isDestructive(op) && op.tag !== "Agent" && !writesStanding(op);

/**
 * Whether a note's text calls on the agent: "@Agent" (whatever the
 * deployment names it) or "@agent", as its own word. An email address
 * like sam@assistant.example doesn't count.
 */
export function mentionsAgent(text: string | null | undefined, name = appConfig.agent.name) {
  if (!text) return false;
  const names = [...new Set([name, "agent"].map((n) => n.trim().toLowerCase()).filter(Boolean))].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(^|[^\\w@.])@(${names.join("|")})(?![\\w@]|\\.\\w)`, "i").test(text);
}

const micro = 1_000_000;
export const usdToMicro = (usd: number) => Math.round(usd * micro);
export const microToUsd = (m: number) => m / micro;

/** The first moment of the month `now` falls in (UTC). Budgets count from here. */
export const monthStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** "$0.42" for a run, "$12" for a budget: whole dollars when there are no cents to show. */
export function formatUsd(usd: number) {
  return `$${Number.isInteger(usd) ? usd : usd.toFixed(2)}`;
}

type Caps = Pick<typeof appConfig.agent.background, "monthlyBudgetUsd" | "maxConcurrentPerUser" | "maxRunUsd" | "maxBulkRecords">;

/** What's been spent this month across the workspace, and how many of this teammate's runs are waiting or working. */
export type BudgetState = { spentMicroUsd: number; active: number };

export const budgetUsedUp = (cfg: Pick<Caps, "monthlyBudgetUsd"> = appConfig.agent.background) =>
  `The agent's background work has used this month's budget (${formatUsd(cfg.monthlyBudgetUsd)}). It starts again next month, or an admin can raise agent.background.monthlyBudgetUsd.`;

/**
 * Why new runs can't be accepted right now, as a sentence, or null when they
 * can. A few run at once (`maxConcurrentPerUser`) and the rest wait their
 * turn, so the cap here is on how many one teammate can have lined up.
 */
export function budgetRefusal(state: BudgetState, wanted = 1, cfg: Caps = appConfig.agent.background): string | null {
  if (state.spentMicroUsd >= usdToMicro(cfg.monthlyBudgetUsd)) return budgetUsedUp(cfg);
  const room = cfg.maxBulkRecords + cfg.maxConcurrentPerUser;
  if (state.active + wanted > room) {
    return state.active
      ? `You already have ${state.active} background ${state.active === 1 ? "task" : "tasks"} waiting or working, and ${room} is the most at once. Wait for some to finish, or cancel them.`
      : `That's ${wanted} tasks at once, and ${cfg.maxBulkRecords} is the most one request can cover. Narrow it down and run it in parts.`;
  }
  return null;
}

/** eve's error for a run, as a sentence the teammate can act on. */
export function runFailure(error: string | null | undefined, cfg: Caps = appConfig.agent.background) {
  const e = error ?? "";
  if (/SESSION_USAGE_LIMIT_REACHED/i.test(e)) {
    return `It reached the spending limit for one task (${formatUsd(cfg.maxRunUsd)}) before finishing. What it changed so far is in the record's history. Ask for a smaller piece of the job, or an admin can raise agent.background.maxRunUsd.`;
  }
  if (/timeout|timed out/i.test(e)) return "It took too long and was stopped. What it changed so far is in the record's history. Try a smaller piece of the job.";
  return "Something went wrong before it could finish. What it changed so far is in the record's history. Try again in a moment.";
}

export type RunRecord = { entity: "person" | "organization" | "client"; id: string; name: string };
export type RunMessageContext = {
  user: { id: string; name: string; email: string; role: UserRole };
  canWrite: boolean;
  workspace: { name: string; timezone: string; currency: string };
  now: Date;
  source: AgentRunSource;
  /** The record the request is about, when there is one. */
  record?: RunRecord | null;
  /** The note that mentioned the agent or the task given to it. */
  activity?: { id: string; type: "note" | "task"; subject: string | null } | null;
  knowledge?: string | null;
  /** The skills section (skillsSection in skill-rules.ts), when the teammate has any. */
  skills?: string | null;
  /** The scheduled job this run is one occurrence of. */
  schedule?: { name: string; cadence: string } | null;
  prompt: string;
};

const answerGoes: Record<AgentRunSource, string> = {
  chat: "Your answer is posted back into their chat with you.",
  api: "Your answer is saved on the run for whoever started it.",
  mention: "Your answer is saved as a note on the same record, in reply to theirs.",
  task: "Your answer is saved on the task, and the task is then marked done. Don't complete or edit the task yourself.",
  bulk: "Your answer is saved on this record's run and listed with the others. Keep it to a few lines.",
  schedule: "Your answer is saved on the run, and they're notified that it's ready. Lead with what changed or needs them since last time. If there's nothing to report, say so in one line.",
};

const asked: Record<AgentRunSource, string> = {
  chat: "They asked in the agent chat.",
  api: "They asked through a connected app.",
  mention: "They mentioned you in a note.",
  task: "They assigned you a task.",
  bulk: "This is one record of a request that covers several. Work on this record only.",
  schedule: "This is a scheduled job they set up. Nobody asked just now.",
};

/** The first message of a run: who it's for, the context a chat would have had, and the request. */
export function runMessage(c: RunMessageContext) {
  const name = appConfig.agent.name;
  const { text, date } = localNow(c.now, c.workspace.timezone);
  const lines = [
    `You are ${name}, working in the background for ${c.user.name} (${c.user.email}), a ${roleLabels[c.user.role].toLowerCase()} at ${c.workspace.name}. Every change you make shows in history as "${c.user.name} via ${name}".`,
    `Their user id is ${c.user.id}: use it for ownerId or assigneeId when the request says "me" or "mine".`,
    `It is ${text}. Today is ${date} in the workspace time zone (${c.workspace.timezone}). Money is in ${c.workspace.currency}.`,
    c.canWrite ? "" : "Their role is read-only, so you can look things up but not change records. If the request needs a change, say so in your answer.",
    asked[c.source],
    c.schedule ? `The job is called "${c.schedule.name}" and runs on this schedule: ${c.schedule.cadence}.` : "",
    c.record ? `The request is about the ${c.record.entity} "${c.record.name}" (id ${c.record.id}).` : "",
    c.activity ? `The ${c.activity.type} has id ${c.activity.id}${c.activity.subject ? ` and is called "${c.activity.subject}"` : ""}.` : "",
    answerGoes[c.source],
    c.knowledge ? `\n## About ${c.workspace.name}\n${c.knowledge}` : "",
    c.skills ? `\n${c.skills}` : "",
    "\n## The request",
    c.prompt.slice(0, MAX_RUN_PROMPT).trim(),
  ];
  return lines.filter(Boolean).join("\n");
}
