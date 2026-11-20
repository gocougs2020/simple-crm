"use client";

import clsx from "clsx";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowPathIcon, CheckCircleIcon, ChevronDownIcon, ClockIcon, ExclamationTriangleIcon, NoSymbolIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { cancelAgentBatch, cancelAgentTask, clearAgentTasks, listAgentTasks, type AgentTask } from "@/actions/agent";
import { appConfig } from "@/app.config";
import { checkForChanges } from "@/components/live-updates";
import { agentRunActive, agentRunStatusLabels, type AgentRunStatus } from "@/lib/constants";
import { Markdown } from "./agent-message";

/** How often the list is read again while something is still going. */
const POLL_MS = 4_000;

/** "an hour", "30 minutes": how long a finished task stays listed. */
function keepLabel() {
  const m = appConfig.agent.background.clearAfterMinutes;
  return m === 60 ? "an hour" : m % 60 === 0 ? `${m / 60} hours` : `${m} minutes`;
}

const sourceLabels: Record<AgentTask["source"], string> = { chat: "From chat", mention: "From a note", task: "From a task", bulk: "Bulk request", api: "From a connected app", schedule: "Scheduled job", email: "From an email" };

function StatusIcon({ status }: { status: AgentRunStatus }) {
  if (status === "running") return <ArrowPathIcon className="size-4 shrink-0 animate-spin text-accent" aria-hidden />;
  if (status === "queued") return <ClockIcon className="size-4 shrink-0 text-muted" aria-hidden />;
  if (status === "done") return <CheckCircleIcon className="size-4 shrink-0 text-success" aria-hidden />;
  if (status === "failed") return <ExclamationTriangleIcon className="size-4 shrink-0 text-error" aria-hidden />;
  return <NoSymbolIcon className="size-4 shrink-0 text-muted" aria-hidden />;
}

const removeButton = "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-sunken hover:text-primary disabled:opacity-50";
const stopButton = "shrink-0 rounded-md border border-line bg-surface px-2 py-1 text-[12px] font-medium text-primary hover:bg-sunken disabled:opacity-50";

/** One bulk request (its tasks share a batch), or a task on its own. */
type Entry = { key: string; batch: AgentTask[] | null; task: AgentTask };

function entriesOf(tasks: AgentTask[]): Entry[] {
  const out: Entry[] = [];
  const batches = new Map<string, AgentTask[]>();
  for (const t of tasks) {
    if (!t.batchId) {
      out.push({ key: t.id, batch: null, task: t });
      continue;
    }
    const seen = batches.get(t.batchId);
    if (seen) seen.push(t);
    else {
      const list = [t];
      batches.set(t.batchId, list);
      out.push({ key: t.batchId, batch: list, task: t });
    }
  }
  return out;
}

/** A task's line: status, title, a Stop button while it's going, a button that takes it off the list, and its answer when opened. */
function TaskRow({ task, nested, open, onToggle, onStop, onRemove, stopping, onNavigate }: { task: AgentTask; nested?: boolean; open: boolean; onToggle: () => void; onStop: () => void; onRemove: () => void; stopping: boolean; onNavigate?: () => void }) {
  const going = agentRunActive(task.status);
  const detail = task.status === "done" ? task.result : task.error;
  return (
    <li className={clsx("border-b border-line last:border-b-0", nested && "bg-sunken/50")}>
      <div className={clsx("flex items-start gap-2 py-2 pr-3", nested ? "pl-9" : "pl-3")}>
        <span className="mt-0.5">
          <StatusIcon status={task.status} />
        </span>
        <button type="button" onClick={onToggle} aria-expanded={open} className="min-w-0 flex-1 text-left">
          <span className="line-clamp-2 text-[13px] leading-snug break-words text-primary">{nested ? task.title.split(": ")[0] : task.title}</span>
          <span className="mt-0.5 block text-[12px] text-muted">
            {agentRunStatusLabels[task.status]}
            {nested ? "" : ` · ${sourceLabels[task.source]}`}
          </span>
        </button>
        {going && !nested ? (
          <button type="button" onClick={onStop} disabled={stopping} className={stopButton}>
            {stopping ? "Stopping…" : "Stop"}
          </button>
        ) : null}
        {!nested ? (
          <button type="button" onClick={onRemove} disabled={stopping} className={removeButton} aria-label={going ? `Stop and remove ${task.title}` : `Remove ${task.title}`} title={going ? "Stop and remove" : "Remove from this list"}>
            <XMarkIcon className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      {open ? (
        <div className={clsx("pr-3 pb-3 text-[13px]", nested ? "pl-[3.75rem]" : "pl-9")}>
          {detail ? <Markdown text={detail} onNavigate={onNavigate} /> : <p className="text-muted">{going ? "Nothing to show yet. The answer appears here when it's done." : "It left no answer."}</p>}
          {task.url ? (
            <Link href={task.url} onClick={onNavigate} className="mt-2 inline-block text-[12.5px] font-medium text-accent underline underline-offset-2">
              Open the record
            </Link>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * What the agent is doing in the background for this teammate, and what
 * it finished lately: a bar under the panel's header that opens into a list.
 * Hidden until there's something to show. `refreshKey` changes when a chat
 * answer ends, since the agent may have just handed a job off.
 */
export function AgentTasks({ open, threadId, refreshKey, onAnswer, onNavigate }: { open: boolean; threadId: string; refreshKey: number; onAnswer: () => void; onNavigate?: () => void }) {
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  // A notification about finished work opens the panel on this list (the launcher opens the panel, which only renders in the browser).
  const [expanded, setExpanded] = useState(() => new URLSearchParams(window.location.search).get("agent") === "tasks");
  const [openId, setOpenId] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState("");
  const wasActive = useRef(new Set<string>());
  const threadRef = useRef(threadId);
  const answerRef = useRef(onAnswer);
  const openRef = useRef(open);
  useEffect(() => {
    threadRef.current = threadId;
    answerRef.current = onAnswer;
    openRef.current = open;
  });

  const load = useCallback(async () => {
    // With the panel open the teammate can see what finished, which starts the time it stays listed.
    const res = await listAgentTasks(openRef.current);
    if (!res.ok) return;
    const list = res.data;
    // Something that was going has finished: the page behind the panel may have changed, and its answer may be in this chat.
    const finished = list.filter((t) => !agentRunActive(t.status) && wasActive.current.has(t.id));
    wasActive.current = new Set(list.filter((t) => agentRunActive(t.status)).map((t) => t.id));
    setTasks(list);
    // While a task is going, the page behind the panel follows what it changes; when one finishes it catches up once more.
    if (finished.length || wasActive.current.size) checkForChanges();
    if (finished.length) {
      if (finished.some((t) => t.threadId === threadRef.current)) answerRef.current();
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, refreshKey, load]);

  // Work that's going is followed with the panel closed too, so the page shows its changes as they land.
  const active = tasks.filter((t) => agentRunActive(t.status)).length;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, load]);

  // A finished task leaves the list on its own when its time comes. The time is already here, so this asks the server nothing.
  useEffect(() => {
    const next = Math.min(...tasks.flatMap((t) => (t.hideAt ? [new Date(t.hideAt).getTime()] : [])));
    if (!Number.isFinite(next)) return;
    const timer = window.setTimeout(() => setTasks((list) => list.filter((t) => !t.hideAt || new Date(t.hideAt).getTime() > Date.now())), Math.max(0, next - Date.now()) + 250);
    return () => window.clearTimeout(timer);
  }, [tasks]);

  const stop = async (key: string, work: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    setStopping(key);
    setError("");
    const res = await work();
    setStopping(null);
    if (!res.ok) setError(res.error);
    void load();
  };

  /** Takes one task, one bulk request or (with no key) everything finished off the list. */
  const clear = async (key: string | null, which: { id?: string; batchId?: string }) => {
    setStopping(key ?? "all");
    setError("");
    const gone = (t: AgentTask) => (which.id ? t.id === which.id : which.batchId ? t.batchId === which.batchId : !agentRunActive(t.status));
    const res = await clearAgentTasks(which);
    setStopping(null);
    if (res.ok) setTasks((list) => list.filter((t) => !gone(t)));
    else setError(res.error);
    void load();
  };

  if (!tasks.length) return null;
  const entries = entriesOf(tasks);
  const finishedCount = tasks.length - active;
  const summary = active ? `Working on ${active} ${active === 1 ? "task" : "tasks"} in the background` : `Background tasks (${entries.length})`;

  return (
    <div className="border-b border-line bg-sunken/80 text-primary">
      <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] font-medium hover:bg-line/40">
        {active ? <ArrowPathIcon className="size-3.5 shrink-0 animate-spin text-accent" aria-hidden /> : <CheckCircleIcon className="size-3.5 shrink-0 text-muted" aria-hidden />}
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        <ChevronDownIcon className={clsx("size-4 shrink-0 text-muted transition-transform", expanded && "rotate-180")} aria-hidden />
      </button>
      {expanded ? (
        <ul className="scroll-thin max-h-72 overflow-y-auto border-t border-line bg-surface" aria-label="Background tasks">
          {finishedCount ? (
            <li className="sticky top-0 z-[1] flex items-center justify-between gap-2 border-b border-line bg-sunken py-1.5 pr-3 pl-3 text-[12px] text-muted">
              <span className="min-w-0">Finished tasks leave this list after {keepLabel()}.</span>
              <button type="button" onClick={() => void clear(null, {})} disabled={stopping === "all"} className={stopButton}>
                {stopping === "all" ? "Clearing…" : "Clear all"}
              </button>
            </li>
          ) : null}
          {error ? (
            <li className="px-3 py-2 text-[12.5px] text-error" role="alert">
              {error}
            </li>
          ) : null}
          {entries.map((entry) => {
            if (!entry.batch) {
              const t = entry.task;
              return <TaskRow key={entry.key} task={t} open={openId === t.id} onToggle={() => setOpenId(openId === t.id ? null : t.id)} onStop={() => void stop(t.id, () => cancelAgentTask(t.id))} onRemove={() => void clear(t.id, { id: t.id })} stopping={stopping === t.id} onNavigate={onNavigate} />;
            }
            const batch = entry.batch;
            const going = batch.filter((t) => agentRunActive(t.status)).length;
            const done = batch.filter((t) => t.status === "done").length;
            const shown = openId === entry.key || batch.some((t) => t.id === openId);
            // "Acme Inc: Find the decision maker" on each task; the request is what follows the record's name.
            const what = entry.task.title.split(": ").slice(1).join(": ") || entry.task.title;
            return (
              <li key={entry.key} className="border-b border-line last:border-b-0">
                <div className="flex items-start gap-2 px-3 py-2">
                  <span className="mt-0.5">
                    <StatusIcon status={going ? "running" : done === batch.length ? "done" : batch.some((t) => t.status === "failed") ? "failed" : "cancelled"} />
                  </span>
                  <button type="button" onClick={() => setOpenId(shown ? null : entry.key)} aria-expanded={shown} className="min-w-0 flex-1 text-left">
                    <span className="line-clamp-2 text-[13px] leading-snug break-words text-primary">{what}</span>
                    <span className="mt-0.5 block text-[12px] text-muted">
                      {done} of {batch.length} done{going ? ` · ${going} to go` : ""} · Bulk request
                    </span>
                  </button>
                  {going ? (
                    <button type="button" onClick={() => void stop(entry.key, () => cancelAgentBatch(entry.key))} disabled={stopping === entry.key} className={stopButton}>
                      {stopping === entry.key ? "Stopping…" : "Stop all"}
                    </button>
                  ) : null}
                  <button type="button" onClick={() => void clear(entry.key, { batchId: entry.key })} disabled={stopping === entry.key} className={removeButton} aria-label={going ? `Stop and remove ${what}` : `Remove ${what}`} title={going ? "Stop and remove" : "Remove from this list"}>
                    <XMarkIcon className="size-3.5" aria-hidden />
                  </button>
                </div>
                {shown ? (
                  <ul className="border-t border-line" aria-label="Records in this request">
                    {batch.map((t) => (
                      <TaskRow key={t.id} task={t} nested open={openId === t.id} onToggle={() => setOpenId(openId === t.id ? entry.key : t.id)} onStop={() => {}} onRemove={() => {}} stopping={false} onNavigate={onNavigate} />
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
