"use client";

import clsx from "clsx";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowPathIcon, CheckCircleIcon, ChevronDownIcon, ClockIcon, ExclamationTriangleIcon, NoSymbolIcon } from "@heroicons/react/24/outline";
import { cancelAgentBatch, cancelAgentTask, listAgentTasks, type AgentTask } from "@/actions/agent";
import { checkForChanges } from "@/components/live-updates";
import { agentRunActive, agentRunStatusLabels, type AgentRunStatus } from "@/lib/constants";
import { Markdown } from "./agent-message";

/** How often the list is read again while something is still going. */
const POLL_MS = 4_000;
/** Finished tasks stay in the list this long. */
const KEEP_MS = 7 * 86_400_000;

const sourceLabels: Record<AgentTask["source"], string> = { chat: "From chat", mention: "From a note", task: "From a task", bulk: "Bulk request", api: "From a connected app" };

function StatusIcon({ status }: { status: AgentRunStatus }) {
  if (status === "running") return <ArrowPathIcon className="size-4 shrink-0 animate-spin text-accent" aria-hidden />;
  if (status === "queued") return <ClockIcon className="size-4 shrink-0 text-muted" aria-hidden />;
  if (status === "done") return <CheckCircleIcon className="size-4 shrink-0 text-success" aria-hidden />;
  if (status === "failed") return <ExclamationTriangleIcon className="size-4 shrink-0 text-error" aria-hidden />;
  return <NoSymbolIcon className="size-4 shrink-0 text-muted" aria-hidden />;
}

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

/** A task's line: status, title, a Stop button while it's going, and its answer when opened. */
function TaskRow({ task, nested, open, onToggle, onStop, stopping, onNavigate }: { task: AgentTask; nested?: boolean; open: boolean; onToggle: () => void; onStop: () => void; stopping: boolean; onNavigate?: () => void }) {
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
  useEffect(() => {
    threadRef.current = threadId;
    answerRef.current = onAnswer;
  });

  const load = useCallback(async () => {
    const res = await listAgentTasks();
    if (!res.ok) return;
    const cutoff = Date.now() - KEEP_MS;
    const list = res.data.filter((t) => agentRunActive(t.status) || !t.finishedAt || new Date(t.finishedAt).getTime() > cutoff);
    // Something that was going has finished: the page behind the panel may have changed, and its answer may be in this chat.
    const finished = list.filter((t) => !agentRunActive(t.status) && wasActive.current.has(t.id));
    wasActive.current = new Set(list.filter((t) => agentRunActive(t.status)).map((t) => t.id));
    setTasks(list);
    if (finished.length) {
      checkForChanges();
      if (finished.some((t) => t.threadId === threadRef.current)) answerRef.current();
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loads the list from the server when the panel opens or an answer ends
    if (open) void load();
  }, [open, refreshKey, load]);

  const active = tasks.filter((t) => agentRunActive(t.status)).length;
  useEffect(() => {
    if (!open || !active) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, active, load]);

  const stop = async (key: string, work: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    setStopping(key);
    setError("");
    const res = await work();
    setStopping(null);
    if (!res.ok) setError(res.error);
    void load();
  };

  if (!tasks.length) return null;
  const entries = entriesOf(tasks);
  const summary = active ? `Working on ${active} ${active === 1 ? "task" : "tasks"} in the background` : `Background tasks (${entries.length})`;

  return (
    <div className="border-b border-line bg-sunken text-primary">
      <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12.5px] font-medium hover:bg-line/40">
        {active ? <ArrowPathIcon className="size-3.5 shrink-0 animate-spin text-accent" aria-hidden /> : <CheckCircleIcon className="size-3.5 shrink-0 text-muted" aria-hidden />}
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        <ChevronDownIcon className={clsx("size-4 shrink-0 text-muted transition-transform", expanded && "rotate-180")} aria-hidden />
      </button>
      {expanded ? (
        <ul className="scroll-thin max-h-72 overflow-y-auto border-t border-line bg-surface" aria-label="Background tasks">
          {error ? <li className="px-3 py-2 text-[12.5px] text-error">{error}</li> : null}
          {entries.map((entry) => {
            if (!entry.batch) {
              const t = entry.task;
              return <TaskRow key={entry.key} task={t} open={openId === t.id} onToggle={() => setOpenId(openId === t.id ? null : t.id)} onStop={() => void stop(t.id, () => cancelAgentTask(t.id))} stopping={stopping === t.id} onNavigate={onNavigate} />;
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
                </div>
                {shown ? (
                  <ul className="border-t border-line" aria-label="Records in this request">
                    {batch.map((t) => (
                      <TaskRow key={t.id} task={t} nested open={openId === t.id} onToggle={() => setOpenId(openId === t.id ? entry.key : t.id)} onStop={() => {}} stopping={false} onNavigate={onNavigate} />
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
