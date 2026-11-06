"use client";

import clsx from "clsx";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  ChatBubbleLeftRightIcon,
  CheckCircleIcon,
  DocumentTextIcon,
  EnvelopeIcon,
  PhoneIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import { logActivity, type ActivityInput } from "@/actions/activities";
import { useApp } from "@/components/app-context";
import { OwnerSelect } from "@/components/records/owner-select";
import { Button } from "@/components/ui/button";
import { Input, Kbd } from "@/components/ui/field";
import { RichText, type RichTextHandle } from "@/components/ui/rich-text";
import { toast } from "@/components/ui/toast";
import { activityLabels, callOutcomes, meetingOutcomes, type ActivityType } from "@/lib/constants";
import { dayFromToday, timeKey, zonedTime } from "@/lib/format";
import { EmailComposer, type EmailRecipient } from "./email-composer";

export const activityIcons: Record<ActivityType, typeof PhoneIcon> = {
  note: DocumentTextIcon,
  call: PhoneIcon,
  email: EnvelopeIcon,
  text: ChatBubbleLeftRightIcon,
  meeting: UsersIcon,
  task: CheckCircleIcon,
};

export type Links = { personId?: string | null; organizationId?: string | null; clientId?: string | null };

/**
 * The one place to record anything about a record. Each tab asks only for
 * what that kind of activity needs; everything defaults to "now, by me", so
 * logging a call is two clicks and a sentence.
 */
export function Composer({ links, recipient, initialType = "note" }: { links: Links; recipient?: EmailRecipient | null; initialType?: ActivityType }) {
  const [type, setType] = useState<ActivityType>(initialType);
  return (
    <div className="rounded-xl border border-line bg-surface shadow-sm">
      <div role="tablist" aria-label="Add activity" className="flex gap-0.5 overflow-x-auto border-b border-line px-2 pt-1.5 [scrollbar-width:none]">
        {(["note", "call", "email", "text", "meeting", "task"] as const).map((t) => {
          const Icon = activityIcons[t];
          const active = t === type;
          return (
            <button
              key={t}
              role="tab"
              aria-selected={active}
              type="button"
              onClick={() => setType(t)}
              className={clsx(
                "-mb-px flex h-9 shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-[13px] font-medium transition-colors",
                active ? "border-accent text-primary" : "border-transparent text-muted hover:text-secondary",
              )}
            >
              <Icon className="size-4" aria-hidden />
              {activityLabels[t]}
            </button>
          );
        })}
      </div>
      <div className="p-3">
        {type === "email" ? <EmailTab links={links} recipient={recipient} /> : <ActivityForm key={type} type={type} links={links} />}
      </div>
    </div>
  );
}

function EmailTab({ links, recipient }: { links: Links; recipient?: EmailRecipient | null }) {
  const [mode, setMode] = useState<"send" | "log">(recipient?.email ? "send" : "log");
  return (
    <div>
      <div className="mb-3 flex items-center gap-1">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "send", label: "Send from CRM" },
            { value: "log", label: "Log an email" },
          ]}
        />
        {mode === "send" && !recipient?.email ? <span className="ml-2 text-[12px] text-muted">Add an email address to this person first.</span> : null}
      </div>
      {mode === "send" && recipient?.email ? <EmailComposer links={links} recipient={recipient} /> : mode === "log" ? <ActivityForm type="email" links={links} /> : null}
    </div>
  );
}

function ActivityForm({ type, links }: { type: ActivityType; links: Links }) {
  const { workspace, viewer } = useApp();
  const tz = workspace.timezone;
  const editor = useRef<RichTextHandle>(null);
  const [body, setBody] = useState("");
  const [subject, setSubject] = useState("");
  const [direction, setDirection] = useState<"outbound" | "inbound">("outbound");
  const [outcome, setOutcome] = useState<string | null>(type === "call" ? "Connected" : null);
  const [duration, setDuration] = useState("");
  // When it happened, or when it's due. Defaults: now for things that happened, tomorrow for tasks.
  const [day, setDay] = useState(() => (type === "task" ? dayFromToday(tz, 1) : dayFromToday(tz)));
  const [time, setTime] = useState(() => (type === "task" ? "" : timeKey(new Date(), tz)));
  const [assigneeId, setAssigneeId] = useState<string | null>(viewer.id);
  const [followUp, setFollowUp] = useState<number | null>(null);
  const [pending, start] = useTransition();

  const now = useNow();
  const isTask = type === "task";
  const at = zonedTime(day || dayFromToday(tz), time || "00:00", tz);
  // A meeting in the future is being scheduled, not logged.
  const planned = isTask || ((type === "meeting" || type === "call") && at.getTime() > now + 60_000);
  const label = isTask ? "Add task" : planned ? `Schedule ${type}` : `Log ${activityLabels[type].toLowerCase()}`;

  const reset = () => {
    editor.current?.clear();
    setBody("");
    setSubject("");
    setDuration("");
    setFollowUp(null);
    setTime(isTask ? "" : timeKey(new Date(), tz));
    setDay(isTask ? dayFromToday(tz, 1) : dayFromToday(tz));
  };

  const submit = () =>
    start(async () => {
      const input: ActivityInput = {
        type,
        subject: subject || null,
        body: body || null,
        ...links,
        ...(type === "call" || type === "email" || type === "text" ? { direction } : {}),
        ...(type === "call" || type === "meeting" ? { outcome: planned ? null : outcome, durationMinutes: duration ? Number(duration) : null } : {}),
        ...(planned ? { dueAt: at.toISOString(), dueHasTime: !!time, assigneeId, done: false } : { occurredAt: at.toISOString(), done: true }),
      };
      const r = await logActivity(input);
      if (!r.ok) return void toast.error(r.error);
      if (followUp !== null) {
        const f = await logActivity({ type: "task", subject: `Follow up${subject ? `: ${subject}` : ""}`, ...links, dueAt: zonedTime(dayFromToday(tz, followUp), "00:00", tz).toISOString(), dueHasTime: false, assigneeId: viewer.id });
        if (!f.ok) toast.error(f.error);
      }
      toast.success(isTask ? "Task added" : planned ? `${activityLabels[type]} scheduled` : `${activityLabels[type]} logged`);
      reset();
    });

  return (
    <div className="flex flex-col gap-2.5">
      {type === "call" || type === "email" || type === "text" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            value={direction}
            onChange={setDirection}
            options={[
              { value: "outbound", label: type === "call" ? "Outgoing" : "Sent", icon: <ArrowUpRightIcon className="size-3.5" /> },
              { value: "inbound", label: type === "call" ? "Incoming" : "Received", icon: <ArrowDownLeftIcon className="size-3.5" /> },
            ]}
          />
          {type === "call" && !planned ? <Chips value={outcome} onChange={setOutcome} options={callOutcomes} /> : null}
        </div>
      ) : null}
      {type === "meeting" && !planned ? <Chips value={outcome} onChange={setOutcome} options={meetingOutcomes} /> : null}
      {isTask || type === "meeting" || type === "email" || (type === "call" && planned) ? (
        <Input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder={isTask ? "What needs to happen?" : type === "meeting" ? "Meeting title" : type === "email" ? "Subject" : "Call about…"}
          aria-label={isTask ? "Task" : "Subject"}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && submit()}
          autoFocus={isTask}
        />
      ) : null}
      {type !== "note" ? (
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <label className="sr-only" htmlFor={`${type}-day`}>
              {isTask ? "Due date" : "Date"}
            </label>
            <Input id={`${type}-day`} type="date" value={day} onChange={(e) => setDay(e.target.value)} className="h-8 w-[9.5rem] text-[13px]" />
            <label className="sr-only" htmlFor={`${type}-time`}>
              Time
            </label>
            <Input id={`${type}-time`} type="time" value={time} onChange={(e) => setTime(e.target.value)} className="h-8 w-[7.5rem] text-[13px]" step={900} />
          </div>
          {type === "call" || type === "meeting" ? (
            <Input
              type="number"
              min={0}
              inputMode="numeric"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              placeholder="Min"
              aria-label="Duration in minutes"
              className="h-8 w-16 text-[13px]"
            />
          ) : null}
          {planned ? (
            <div className="w-40">
              <OwnerSelect value={assigneeId} onChange={setAssigneeId} allowNone={false} className="[&_select]:h-8 [&_select]:text-[13px]" />
            </div>
          ) : null}
          {!planned ? <FollowUp value={followUp} onChange={setFollowUp} /> : null}
        </div>
      ) : null}
      <RichText
        handle={editor}
        value={body}
        onChange={setBody}
        onSubmit={submit}
        minHeight={isTask ? 44 : 72}
        actions={
          <>
            <span className="hidden text-[11.5px] text-faint sm:inline">
              <Kbd>⌘</Kbd> <Kbd>↵</Kbd>
            </span>
            <Button variant="primary" size="sm" loading={pending} onClick={submit}>
              {label}
            </Button>
          </>
        }
        placeholder={
          {
            note: "Write a note. Only your team sees it.",
            call: "What did you talk about?",
            email: "Paste or summarize the email",
            text: "Paste the text message",
            meeting: "Agenda or notes",
            task: "Details (optional)",
          }[type]
        }
      />
    </div>
  );
}

/** "Follow up in…": schedules a task for the same record right after logging. */
function FollowUp({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const options = [
    { days: 1, label: "Tomorrow" },
    { days: 3, label: "3 days" },
    { days: 7, label: "1 week" },
    { days: 14, label: "2 weeks" },
  ];
  return (
    <div className="flex items-center gap-1 text-[12.5px] text-muted">
      <span>Follow up</span>
      {options.map((o) => (
        <button
          key={o.days}
          type="button"
          aria-pressed={value === o.days}
          onClick={() => onChange(value === o.days ? null : o.days)}
          className={clsx(
            "h-6 rounded-full border px-2 font-medium transition-colors",
            value === o.days ? "border-accent bg-accent text-accent-foreground" : "border-line text-secondary hover:border-line-strong",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; icon?: ReactNode }[] }) {
  return (
    <div className="inline-flex rounded-md border border-line bg-sunken p-0.5" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            "flex h-7 items-center gap-1 rounded-[5px] px-2.5 text-[12.5px] font-medium transition-colors",
            value === o.value ? "bg-surface text-primary shadow-sm" : "text-muted hover:text-secondary",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Chips({ value, onChange, options }: { value: string | null; onChange: (v: string | null) => void; options: readonly string[] }) {
  return (
    <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Outcome">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          role="radio"
          aria-checked={value === o}
          onClick={() => onChange(value === o ? null : o)}
          className={clsx(
            "h-7 rounded-full border px-2.5 text-[12.5px] font-medium transition-colors",
            value === o ? "border-accent bg-accent-soft text-primary" : "border-line text-muted hover:border-line-strong hover:text-secondary",
          )}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

/** The current time, refreshed every 30 seconds, so "is this in the future?" stays right while a form is open. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}
