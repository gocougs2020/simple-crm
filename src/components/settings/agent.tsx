"use client";

import { useState, useTransition, type ReactNode } from "react";
import { PlusIcon } from "@heroicons/react/20/solid";
import { addSharedJob, deleteJob, deleteSkill, runJobNow, saveJob, saveSkill, shareJob } from "@/actions/agent-settings";
import { appConfig } from "@/app.config";
import { useApp } from "@/components/app-context";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { cadenceLabel, canEditJob, clockLabel, MAX_JOB_NAME, MAX_JOB_REQUEST } from "@/lib/agent/schedule-rules";
import { canEditSkill, MAX_ALWAYS_INSTRUCTIONS, MAX_SKILL_DESCRIPTION, MAX_SKILL_INSTRUCTIONS, MAX_SKILL_NAME } from "@/lib/agent/skill-rules";
import { agentSkillModeLabels, agentSkillModes, scheduleEvery, type AgentScope, type AgentSkillMode, type ScheduleEvery } from "@/lib/constants";
import { formatDateTime } from "@/lib/format";
import { Section } from "./nav";

export type SkillItem = {
  id: string;
  name: string;
  description: string;
  instructions: string | null;
  mode: AgentSkillMode;
  scope: AgentScope;
  enabled: boolean;
  ownerId: string;
  ownerName: string;
};

export type JobItem = {
  id: string;
  name: string;
  request: string;
  every: ScheduleEvery;
  time: string;
  weekday: number | null;
  monthDay: number | null;
  onDate: string | null;
  scope: AgentScope;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  ownerId: string;
  ownerName: string;
  fromId: string | null;
};

const everyLabels: Record<ScheduleEvery, string> = { day: "Every day", weekday: "Every weekday (Monday to Friday)", week: "Every week", month: "Every month", once: "Once" };
const weekdayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const quarterHours = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`);

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-center text-[13px] text-muted">{children}</p>;
}

/**
 * Settings → Agent. Skills are instructions the agent follows; scheduled jobs
 * are work it does on its own. Each teammate has their own of both, and
 * admins share some with the whole team: a shared skill is used by everyone's
 * agent, and a shared job is offered for each teammate to add.
 */
export function AgentSettings({ skills, jobs, background }: { skills: SkillItem[]; jobs: JobItem[]; background: boolean }) {
  const { viewer, isAdmin, canEdit, workspace, workspaceTimezone } = useApp();
  const name = appConfig.agent.name;
  const [skill, setSkill] = useState<SkillItem | { new: AgentScope } | null>(null);
  const [job, setJob] = useState<JobItem | { new: AgentScope } | null>(null);
  const [pending, start] = useTransition();

  const mySkills = skills.filter((s) => s.scope === "personal" && s.ownerId === viewer.id);
  const sharedSkills = skills.filter((s) => s.scope === "workspace");
  const otherSkills = skills.filter((s) => s.scope === "personal" && s.ownerId !== viewer.id);
  const myJobs = jobs.filter((j) => j.scope === "personal" && j.ownerId === viewer.id);
  const sharedJobs = jobs.filter((j) => j.scope === "workspace");
  const otherJobs = jobs.filter((j) => j.scope === "personal" && j.ownerId !== viewer.id);
  const added = new Set(myJobs.map((j) => j.fromId).filter(Boolean));

  const skillRows = (list: SkillItem[], owner = false) => (
    <ul className="divide-y divide-line">
      {list.map((s) => (
        <li key={s.id}>
          <button type="button" className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-sunken" onClick={() => setSkill(s)}>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium text-primary">{s.name}</span>
              <span className="block truncate text-[12.5px] text-muted">{s.description}</span>
            </span>
            {owner ? <span className="shrink-0 text-[12.5px] text-muted">{s.ownerName}</span> : null}
            {!s.enabled ? <StatusBadge>Paused</StatusBadge> : s.mode === "always" ? <StatusBadge tone="info">Always on</StatusBadge> : null}
          </button>
        </li>
      ))}
    </ul>
  );

  const jobRows = (list: JobItem[], kind: "mine" | "shared" | "others") => (
    <ul className="divide-y divide-line">
      {list.map((j) => (
        <li key={j.id} className="flex items-center gap-3 pr-4">
          <button type="button" className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 text-left hover:bg-sunken" onClick={() => setJob(j)}>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium text-primary">{j.name}</span>
              <span className="block truncate text-[12.5px] text-muted">
                {cadenceLabel(j)}
                {kind !== "shared" && j.enabled && j.nextRunAt ? ` · Next ${formatDateTime(j.nextRunAt, workspace.timezone)}` : ""}
              </span>
              {kind !== "shared" && j.lastError ? <span className="block truncate text-[12.5px] text-error">{j.lastError}</span> : null}
            </span>
            {kind === "others" ? <span className="shrink-0 text-[12.5px] text-muted">{j.ownerName}</span> : null}
            {kind !== "shared" && !j.enabled ? <StatusBadge>{j.every === "once" && j.lastRunAt ? "Done" : "Paused"}</StatusBadge> : null}
          </button>
          {kind === "shared" && canEdit && background ? (
            added.has(j.id) ? (
              <StatusBadge tone="success">Added</StatusBadge>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await addSharedJob(j.id);
                    if (!r.ok) return void toast.error(r.error);
                    toast.success(`${j.name} added to your jobs`);
                  })
                }
              >
                Add to mine
              </Button>
            )
          ) : null}
        </li>
      ))}
    </ul>
  );

  return (
    <>
      <Section
        title="Your skills"
        description={`How you want things done: a write-up format, what to check before a call, your tone in emails. ${name} follows them in chat, in background work and through MCP. Ask ${name} to save one, or add it here.`}
        action={
          canEdit ? (
            <Button size="sm" variant="outline" onClick={() => setSkill({ new: "personal" })}>
              <PlusIcon />
              Add skill
            </Button>
          ) : null
        }
      >
        {mySkills.length ? skillRows(mySkills) : <Empty>{canEdit ? `No skills yet. Add one, or tell ${name} "from now on, …" in chat.` : "Your role can use the team's shared skills but not save its own."}</Empty>}
      </Section>

      <Section
        title="Shared with the team"
        description={`Skills an admin made available to everyone. Every teammate's ${name} follows them.`}
        action={
          isAdmin ? (
            <Button size="sm" variant="outline" onClick={() => setSkill({ new: "workspace" })}>
              <PlusIcon />
              Add shared skill
            </Button>
          ) : null
        }
      >
        {sharedSkills.length ? skillRows(sharedSkills) : <Empty>{isAdmin ? "Nothing shared yet. Add a skill for everyone, or open one of yours or a teammate's and share it." : "Nothing shared yet. An admin can share skills with the whole team."}</Empty>}
      </Section>

      {isAdmin && otherSkills.length ? (
        <Section title="Teammates' skills" description="What your teammates saved for themselves. Open one to share it with the whole team.">
          {skillRows(otherSkills, true)}
        </Section>
      ) : null}

      <Section
        title="Your scheduled jobs"
        description={`Work ${name} does on its own, on a schedule, as you and with your access. Each run shows under Background tasks in the ${name} panel and sends you a notification. Times are in ${workspaceTimezone}.`}
        action={
          canEdit && background ? (
            <Button size="sm" variant="outline" onClick={() => setJob({ new: "personal" })}>
              <PlusIcon />
              Add job
            </Button>
          ) : null
        }
      >
        {!background ? (
          <Empty>Scheduled jobs need background work, which is off on this deployment. An admin can turn it on (docs/AGENT.md).</Empty>
        ) : myJobs.length ? (
          jobRows(myJobs, "mine")
        ) : (
          <Empty>{canEdit ? `No scheduled jobs yet. Add one, or ask ${name} for something "every Monday morning".` : "Your role can't schedule jobs, since a job changes records. Ask an admin for edit access."}</Empty>
        )}
      </Section>

      {background ? (
        <Section
          title="Offered to the team"
          description="Jobs an admin set up for anyone to use. Adding one gives you your own copy, which runs as you and can be changed without affecting anyone else."
          action={
            isAdmin ? (
              <Button size="sm" variant="outline" onClick={() => setJob({ new: "workspace" })}>
                <PlusIcon />
                Add shared job
              </Button>
            ) : null
          }
        >
          {sharedJobs.length ? jobRows(sharedJobs, "shared") : <Empty>{isAdmin ? "Nothing offered yet. Add a job for the team, or open one of yours or a teammate's and share it." : "Nothing offered yet. An admin can offer jobs to the whole team."}</Empty>}
        </Section>
      ) : null}

      {isAdmin && background && otherJobs.length ? (
        <Section title="Teammates' jobs" description="What your teammates scheduled for themselves. Open one to pause it or offer it to the whole team.">
          {jobRows(otherJobs, "others")}
        </Section>
      ) : null}

      {skill ? <SkillDialog skill={"new" in skill ? null : skill} scope={"new" in skill ? skill.new : skill.scope} onClose={() => setSkill(null)} /> : null}
      {job ? <JobDialog job={"new" in job ? null : job} scope={"new" in job ? job.new : job.scope} onClose={() => setJob(null)} /> : null}
    </>
  );
}

function SkillDialog({ skill, scope, onClose }: { skill: SkillItem | null; scope: AgentScope; onClose: () => void }) {
  const { viewer, isAdmin, canEdit } = useApp();
  const agent = appConfig.agent.name;
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [instructions, setInstructions] = useState(skill?.instructions ?? "");
  const [mode, setMode] = useState<AgentSkillMode>(skill?.mode ?? "on_demand");
  const [enabled, setEnabled] = useState(skill?.enabled ?? true);
  const [shared, setShared] = useState(scope === "workspace");
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const editable = canEdit && (skill ? canEditSkill({ id: viewer.id, admin: isAdmin }, { scope: skill.scope, userId: skill.ownerId }) : true);
  const others = skill && skill.ownerId !== viewer.id;
  const tooLong = mode === "always" && instructions.length > MAX_ALWAYS_INSTRUCTIONS;

  const save = () =>
    start(async () => {
      const r = await saveSkill(skill?.id ?? null, { name, description, instructions, mode, enabled, scope: shared ? "workspace" : "personal" });
      if (!r.ok) return void toast.error(r.error);
      toast.success(skill ? "Skill saved" : `${name.trim()} added`);
      onClose();
    });
  const remove = () =>
    start(async () => {
      const r = await deleteSkill(skill!.id);
      if (!r.ok) return void toast.error(r.error);
      toast.success(`${skill!.name} deleted`);
      onClose();
    });

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={skill ? skill.name : shared ? "Add a shared skill" : "Add a skill"}
      description={
        skill
          ? skill.scope === "workspace"
            ? `Shared with the team by ${skill.ownerName}.${editable ? "" : " Admins manage shared skills."}`
            : others
              ? `${skill.ownerName}'s own skill.`
              : undefined
          : `Instructions ${agent} follows when the work calls for them.`
      }
      size="lg"
      footer={
        editable ? (
          <>
            {skill ? (
              confirming ? (
                <span className="mr-auto flex items-center gap-2 text-[13px] text-secondary">
                  Delete it for good?
                  <Button size="sm" variant="ghost" className="text-error" loading={pending} onClick={remove}>
                    Delete
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                    Keep
                  </Button>
                </span>
              ) : (
                <Button variant="ghost" className="mr-auto text-error" onClick={() => setConfirming(true)}>
                  Delete
                </Button>
              )
            ) : null}
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={pending && !confirming} disabled={tooLong} onClick={save}>
              {skill ? "Save" : "Add skill"}
            </Button>
          </>
        ) : (
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      <div className="grid gap-4">
        <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={MAX_SKILL_NAME} placeholder="Call write-ups" disabled={!editable} />}</Field>
        <Field label="When to use it" hint={`One sentence ${agent} matches a request against.`}>
          {(p) => <Input {...p} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={MAX_SKILL_DESCRIPTION} placeholder="Use when logging a call or writing up a meeting." disabled={!editable} />}
        </Field>
        <Field label="Instructions" error={tooLong ? `A skill that's always on can be up to ${MAX_ALWAYS_INSTRUCTIONS.toLocaleString("en-US")} characters. This is ${instructions.length.toLocaleString("en-US")}.` : null} hint="What to do, step by step. Plain words or markdown.">
          {(p) => (
            <Textarea
              {...p}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              maxLength={MAX_SKILL_INSTRUCTIONS}
              rows={10}
              className="font-mono text-[13px]"
              placeholder={"Keep it to three bullets: what they need, what we agreed, the next step with a date.\nAdd a follow-up task for the next step."}
              disabled={!editable}
            />
          )}
        </Field>
        <Field label="Used" hint={agentSkillModeLabels[mode].hint}>
          {(p) => (
            <Select id={p.id} value={mode} onChange={(e) => setMode(e.target.value as AgentSkillMode)} disabled={!editable}>
              {agentSkillModes.map((m) => (
                <option key={m} value={m}>
                  {agentSkillModeLabels[m].label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {editable ? (
          <div className="flex flex-col gap-2">
            {isAdmin ? <Checkbox checked={shared} onChange={(e) => setShared(e.target.checked)} label={`Shared with the team: every teammate's ${agent} uses it`} /> : null}
            {skill ? <Checkbox checked={enabled} onChange={(e) => setEnabled(e.target.checked)} label="On" /> : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

function JobDialog({ job, scope, onClose }: { job: JobItem | null; scope: AgentScope; onClose: () => void }) {
  const { viewer, isAdmin, canEdit, workspace, workspaceTimezone } = useApp();
  const agent = appConfig.agent.name;
  const [name, setName] = useState(job?.name ?? "");
  const [request, setRequest] = useState(job?.request ?? "");
  const [every, setEvery] = useState<ScheduleEvery>(job?.every ?? "weekday");
  const [time, setTime] = useState(job?.time ?? "08:00");
  const [weekday, setWeekday] = useState(job?.weekday ?? 1);
  const [monthDay, setMonthDay] = useState(job?.monthDay ?? 1);
  const [onDate, setOnDate] = useState(job?.onDate ?? "");
  const [enabled, setEnabled] = useState(job?.enabled ?? true);
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const offer = scope === "workspace";
  const mine = !job || job.ownerId === viewer.id;
  const editable = canEdit && (job ? canEditJob({ id: viewer.id, admin: isAdmin }, { scope: job.scope, userId: job.ownerId }) : true);

  const act = (work: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string) =>
    start(async () => {
      const r = await work();
      if (!r.ok) return void toast.error(r.error);
      toast.success(done);
      onClose();
    });
  const save = () =>
    act(
      () => saveJob(job?.id ?? null, { name, request, every, time, weekday: every === "week" ? weekday : null, monthDay: every === "month" ? monthDay : null, onDate: every === "once" ? onDate : null, ...(job ? { enabled } : { scope }) }),
      job ? "Job saved" : offer ? `${name.trim()} offered to the team` : `${name.trim()} scheduled`,
    );

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={job ? job.name : offer ? "Add a shared job" : "Add a scheduled job"}
      description={
        job
          ? offer
            ? `Offered to the team by ${job.ownerName}. It runs for whoever adds it.${editable ? " Changes here don't reach copies teammates already added." : ""}`
            : mine
              ? job.nextRunAt && job.enabled
                ? `Runs next ${formatDateTime(job.nextRunAt, workspace.timezone)}.`
                : undefined
              : `${job.ownerName}'s job. It runs as them.`
          : offer
            ? "Teammates who add it get their own copy, which runs as them."
            : `${agent} does this on its own, as you, and tells you when it's done.`
      }
      size="lg"
      footer={
        editable ? (
          <>
            {job ? (
              confirming ? (
                <span className="mr-auto flex items-center gap-2 text-[13px] text-secondary">
                  Delete it for good?
                  <Button size="sm" variant="ghost" className="text-error" loading={pending} onClick={() => act(() => deleteJob(job.id), `${job.name} deleted`)}>
                    Delete
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                    Keep
                  </Button>
                </span>
              ) : (
                <span className="mr-auto flex items-center gap-1">
                  <Button variant="ghost" className="text-error" onClick={() => setConfirming(true)}>
                    Delete
                  </Button>
                  {!offer && mine ? (
                    <Button variant="ghost" disabled={pending} onClick={() => act(() => runJobNow(job.id), `${job.name} is running. The answer will be in Background tasks.`)}>
                      Run now
                    </Button>
                  ) : null}
                  {!offer && isAdmin ? (
                    <Button variant="ghost" disabled={pending} onClick={() => act(() => shareJob(job.id), `${job.name} offered to the team`)}>
                      Share with the team
                    </Button>
                  ) : null}
                </span>
              )
            ) : null}
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={pending && !confirming} onClick={save}>
              {job ? "Save" : offer ? "Offer to the team" : "Schedule"}
            </Button>
          </>
        ) : (
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" className="sm:col-span-2">
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={MAX_JOB_NAME} placeholder="Monday pipeline review" disabled={!editable} />}
        </Field>
        <Field label="What to do" className="sm:col-span-2" hint={`It runs in the background and can't ask questions, so say everything it needs. It can't send, archive, delete or merge.`}>
          {(p) => (
            <Textarea
              {...p}
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              maxLength={MAX_JOB_REQUEST}
              rows={6}
              placeholder="List my prospective clients with no activity in the last 14 days and no open task. For each, say the last contact and suggest a next step."
              disabled={!editable}
            />
          )}
        </Field>
        <Field label="How often">
          {(p) => (
            <Select id={p.id} value={every} onChange={(e) => setEvery(e.target.value as ScheduleEvery)} disabled={!editable}>
              {scheduleEvery.map((v) => (
                <option key={v} value={v}>
                  {everyLabels[v]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Time" hint={workspaceTimezone}>
          {(p) => (
            <Select id={p.id} value={time} onChange={(e) => setTime(e.target.value)} disabled={!editable}>
              {quarterHours.map((t) => (
                <option key={t} value={t}>
                  {clockLabel(t)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {every === "week" ? (
          <Field label="Day">
            {(p) => (
              <Select id={p.id} value={weekday} onChange={(e) => setWeekday(Number(e.target.value))} disabled={!editable}>
                {weekdayNames.map((d, i) => (
                  <option key={d} value={i + 1}>
                    {d}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        {every === "month" ? (
          <Field label="Day of the month" hint="1 to 28, so it runs every month.">
            {(p) => (
              <Select id={p.id} value={monthDay} onChange={(e) => setMonthDay(Number(e.target.value))} disabled={!editable}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        {every === "once" ? <Field label="Date">{(p) => <Input {...p} type="date" value={onDate} onChange={(e) => setOnDate(e.target.value)} disabled={!editable} />}</Field> : null}
        {job && !offer && editable ? <Checkbox className="sm:col-span-2" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} label="On" /> : null}
        {job && !offer && job.lastError ? <p className="text-[13px] text-error sm:col-span-2">Last run: {job.lastError}</p> : null}
      </div>
    </Dialog>
  );
}
