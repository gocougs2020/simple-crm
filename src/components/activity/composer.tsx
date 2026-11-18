"use client";

import clsx from "clsx";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { PaperClipIcon, XMarkIcon } from "@heroicons/react/20/solid";
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  ChatBubbleLeftRightIcon,
  CheckCircleIcon,
  DocumentTextIcon,
  EnvelopeIcon,
  PhoneIcon,
  SparklesIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import { logActivity, type ActivityInput } from "@/actions/activities";
import { listPersonDrafts, resolveDraft, type PersonDraft } from "@/actions/drafts";
import { useApp } from "@/components/app-context";
import { ASSISTANT_ASSIGNEE, OwnerSelect } from "@/components/records/owner-select";
import { appConfig } from "@/app.config";
import { Button } from "@/components/ui/button";
import { Input, Kbd } from "@/components/ui/field";
import { RichText, type RichTextHandle } from "@/components/ui/rich-text";
import { toast } from "@/components/ui/toast";
import { activityLabels, callOutcomes, meetingOutcomes, type ActivityType } from "@/lib/constants";
import { dayFromToday, timeKey, zonedTime } from "@/lib/format";
import { CallButton } from "@/components/phone/contact-actions";
import { TextComposer } from "@/components/phone/text-composer";
import { EmailComposer, type EmailRecipient } from "./email-composer";
import { useUploader } from "@/components/files/files-panel";

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
export function Composer({ links, recipient, initialType = "note" }: { links: Links; recipient?: (EmailRecipient & { phone?: string | null; textOptedOut?: boolean }) | null; initialType?: ActivityType }) {
  const [type, setType] = useState<ActivityType>(initialType);
  const { canEdit, services } = useApp();
  // Emails and texts the assistant drafted to this person, waiting for this teammate to review and send (docs/AGENT.md).
  const [drafts, setDrafts] = useState<PersonDraft[]>([]);
  const [reviewing, setReviewing] = useState<PersonDraft | null>(null);
  const personId = recipient?.personId;
  const assistantOn = services.ai.chat || services.ai.background;
  useEffect(() => {
    if (!personId || !canEdit || !assistantOn) return;
    let current = true;
    listPersonDrafts(personId).then((r) => {
      if (!current || !r.ok) return;
      setDrafts(r.data);
      // A link from the assistant or a notification (?draft=…) opens that draft in the composer.
      const wanted = new URLSearchParams(window.location.search).get("draft");
      const open = wanted ? r.data.find((d) => d.id === wanted) : null;
      if (open) {
        setReviewing(open);
        setType(open.kind);
      }
    });
    return () => {
      current = false;
    };
  }, [personId, canEdit, assistantOn]);
  // Viewers read the timeline but can't log to it.
  if (!canEdit) return null;

  const review = (d: PersonDraft) => {
    setReviewing(d);
    setType(d.kind);
  };
  const settle = (d: PersonDraft, outcome: "sent" | "discarded") => {
    setDrafts((list) => list.filter((x) => x.id !== d.id));
    setReviewing((r) => (r?.id === d.id ? null : r));
    void resolveDraft(d.id, outcome).then((r) => {
      if (!r.ok) toast.error(r.error);
    });
  };
  const emailDraft = reviewing?.kind === "email" ? reviewing : null;
  const textDraft = reviewing?.kind === "text" ? reviewing : null;

  return (
    <div className="rounded-xl border border-line bg-surface shadow-sm">
      {drafts.length ? (
        <ul className="border-b border-line bg-info-surface text-[13px] text-primary" aria-label={`Drafts from ${appConfig.agent.name}`}>
          {drafts.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2 border-b border-info-border px-3 py-2 last:border-b-0">
              <SparklesIcon className="size-4 shrink-0 text-info" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="font-medium">
                  {appConfig.agent.name} drafted {d.kind === "email" ? "an email" : "a text"}
                  {recipient ? ` to ${recipient.name}` : ""}
                </span>
                {d.subject ? <span className="text-secondary">: {d.subject}</span> : null}
                {reviewing?.id === d.id ? <span className="text-secondary"> · open below. Change what you like, then send.</span> : null}
              </span>
              {reviewing?.id === d.id ? null : (
                <Button size="sm" variant="outline" className="h-7" onClick={() => review(d)}>
                  Review and send
                </Button>
              )}
              <Button size="sm" variant="ghost" className="h-7" onClick={() => settle(d, "discarded")}>
                Discard
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
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
        {type === "email" ? (
          <EmailTab key={emailDraft?.id ?? "email"} links={links} recipient={recipient} draft={emailDraft} onDraftSent={emailDraft ? () => settle(emailDraft, "sent") : undefined} />
        ) : type === "text" ? (
          <TextTab key={textDraft?.id ?? "text"} links={links} recipient={recipient} draft={textDraft} onDraftSent={textDraft ? () => settle(textDraft, "sent") : undefined} />
        ) : (
          <>
            {type === "call" && recipient?.phone ? <CallNow links={links} recipient={recipient} /> : null}
            <ActivityForm key={type} type={type} links={links} />
          </>
        )}
      </div>
    </div>
  );
}

type DraftProps = { draft?: PersonDraft | null; onDraftSent?: () => void };

function EmailTab({ links, recipient, draft, onDraftSent }: { links: Links; recipient?: EmailRecipient | null } & DraftProps) {
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
      {mode === "send" && recipient?.email ? <EmailComposer links={links} recipient={recipient} draft={draft} onDraftSent={onDraftSent} /> : mode === "log" ? <ActivityForm type="email" links={links} /> : null}
    </div>
  );
}

/** Texting through the team's numbers when it's set up and the person has a phone; logging a text sent some other way otherwise. */
function TextTab({ links, recipient, draft, onDraftSent }: { links: Links; recipient?: (EmailRecipient & { phone?: string | null; textOptedOut?: boolean }) | null } & DraftProps) {
  const { comms } = useApp();
  const canSend = comms.texting && !!recipient?.phone;
  const [mode, setMode] = useState<"send" | "log">(canSend ? "send" : "log");
  if (!comms.texting) return <ActivityForm type="text" links={links} />;
  return (
    <div>
      <div className="mb-3 flex items-center gap-1">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "send", label: "Send from CRM" },
            { value: "log", label: "Log a text" },
          ]}
        />
        {mode === "send" && !recipient?.phone ? <span className="ml-2 text-[12px] text-muted">{recipient ? "Add a phone number to this person first." : "Text a person from their page."}</span> : null}
      </div>
      {mode === "send" && recipient?.phone ? (
        <TextComposer recipient={{ personId: recipient.personId, name: recipient.name, phone: recipient.phone, optedOut: recipient.textOptedOut }} clientId={links.clientId} draft={draft} onDraftSent={onDraftSent} />
      ) : mode === "log" ? (
        <ActivityForm type="text" links={links} />
      ) : null}
    </div>
  );
}

/** "Call Sam now" above the call form, when calling from the browser is set up. The call logs itself; this form is for calls made some other way. */
function CallNow({ links, recipient }: { links: Links; recipient: EmailRecipient & { phone?: string | null } }) {
  const { comms } = useApp();
  if (!comms.calling) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-sunken px-3 py-2">
      <span className="min-w-0 flex-1 text-[13px] text-secondary">
        Call {recipient.name} from the browser. It&apos;s logged here with how long it lasted, and you can take notes as you talk.
      </span>
      <CallButton target={{ name: recipient.name, phone: recipient.phone, personId: recipient.personId, clientId: links.clientId }} variant="primary" label="Call now" />
    </div>
  );
}

function ActivityForm({ type, links }: { type: ActivityType; links: Links }) {
  const { workspace, viewer, services, canEdit } = useApp();
  const tz = workspace.timezone;
  // Background work (docs/AGENT.md): tasks can go to the assistant, and a note can call on it with @Assistant.
  const assistantWorks = services.ai.background && canEdit;
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
  /** Files to attach once the activity is saved. */
  const [attached, setAttached] = useState<File[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  const uploader = useUploader(links);
  const [pending, start] = useTransition();

  const now = useNow();
  const isTask = type === "task";
  const at = zonedTime(day || dayFromToday(tz), time || "00:00", tz);
  // A meeting in the future is being scheduled, not logged.
  const planned = isTask || ((type === "meeting" || type === "call") && at.getTime() > now + 60_000);
  const forAssistant = isTask && assigneeId === ASSISTANT_ASSIGNEE;
  const label = forAssistant ? `Give to ${appConfig.agent.name}` : isTask ? "Add task" : planned ? `Schedule ${type}` : `Log ${activityLabels[type].toLowerCase()}`;

  const reset = () => {
    editor.current?.clear();
    setBody("");
    setSubject("");
    setDuration("");
    setFollowUp(null);
    setAttached([]);
    setTime(isTask ? "" : timeKey(new Date(), tz));
    setDay(isTask ? dayFromToday(tz, 1) : dayFromToday(tz));
  };

  const submit = () =>
    start(async () => {
      // A note that's only files: attach them to the record, no empty note needed.
      if (type === "note" && !body && attached.length) {
        await uploader.run(attached);
        return reset();
      }
      const input: ActivityInput = {
        type,
        subject: subject || null,
        body: body || null,
        ...links,
        ...(type === "call" || type === "email" || type === "text" ? { direction } : {}),
        ...(type === "call" ? { outcome: planned ? null : outcome } : {}),
        ...(type === "meeting" ? { outcome: planned ? null : outcome, durationMinutes: duration ? Number(duration) : null } : {}),
        ...(planned ? { dueAt: at.toISOString(), dueHasTime: !!time, ...(forAssistant ? { assigneeId: viewer.id, assistant: true } : { assigneeId }), done: false } : { occurredAt: at.toISOString(), done: true }),
      };
      const r = await logActivity(input);
      if (!r.ok) return void toast.error(r.error);
      if (attached.length) await uploader.run(attached, { activityId: r.data.id });
      if (followUp !== null) {
        const f = await logActivity({ type: "task", subject: `Follow up${subject ? `: ${subject}` : ""}`, ...links, dueAt: zonedTime(dayFromToday(tz, followUp), "00:00", tz).toISOString(), dueHasTime: false, assigneeId: viewer.id });
        if (!f.ok) toast.error(f.error);
      }
      toast.success(forAssistant ? `${appConfig.agent.name} is on it. The answer lands on the task.` : isTask ? "Task added" : planned ? `${activityLabels[type]} scheduled` : `${activityLabels[type]} logged`);
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
          {type === "meeting" ? (
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
              <OwnerSelect value={assigneeId} onChange={setAssigneeId} allowNone={false} assistant={isTask && assistantWorks} className="[&_select]:h-8 [&_select]:text-[13px]" />
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
        dictation
        actions={
          <Button size="sm" variant="ghost" className="h-7" onClick={() => picker.current?.click()}>
            <PaperClipIcon />
            Attach
          </Button>
        }
        placeholder={
          {
            note: assistantWorks ? `Write a note. Only your team sees it. Type @${appConfig.agent.name} to hand it something.` : "Write a note. Only your team sees it.",
            call: "What did you talk about?",
            email: "Paste or summarize the email",
            text: "Paste the text message",
            meeting: "Agenda or notes",
            task: forAssistant ? "What should it do? Say what to find or change." : "Details (optional)",
          }[type]
        }
      />
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const picked = [...(e.target.files ?? [])];
          setAttached((list) => [...list, ...picked]);
          e.target.value = "";
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        {attached.map((f, i) => (
          <span key={`${f.name}-${i}`} className="inline-flex h-7 max-w-56 items-center gap-1 rounded-full border border-line bg-sunken pr-1 pl-2.5 text-[12px] text-secondary">
            <PaperClipIcon className="size-3.5 shrink-0 text-faint" aria-hidden />
            <span className="truncate">{f.name}</span>
            <button type="button" onClick={() => setAttached((list) => list.filter((_, j) => j !== i))} className="rounded-full p-0.5 text-faint hover:text-primary" aria-label={`Don't attach ${f.name}`}>
              <XMarkIcon className="size-3.5" />
            </button>
          </span>
        ))}
        {uploader.uploads.length ? <span className="text-[12px] text-muted">Uploading {uploader.uploads.length === 1 ? uploader.uploads[0].name : `${uploader.uploads.length} files`}…</span> : null}
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-[11.5px] text-faint sm:inline">
            <Kbd>⌘</Kbd> <Kbd>↵</Kbd>
          </span>
          <Button variant="primary" size="sm" loading={pending} onClick={submit}>
            {label}
          </Button>
        </div>
      </div>
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
