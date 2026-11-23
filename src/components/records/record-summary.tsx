"use client";

import clsx from "clsx";
import { useEffect, useState } from "react";
import { ArrowPathIcon, SparklesIcon } from "@heroicons/react/24/outline";
import { recordSummary } from "@/actions/agent";
import { appConfig } from "@/app.config";
import { useApp } from "@/components/app-context";
import { Spinner } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { formatAgo } from "@/lib/format";
import { isFresh, type SummaryEntity } from "@/lib/agent/summary-prompt";

/**
 * The AI snapshot at the top of a record: who they are, the latest that
 * matters, what needs attention. Shown straight from the record; when it's
 * missing or more than a day old, a new one is written while the old one
 * stays on screen, with "Re-summarizing…" in the corner. The refresh button
 * under the sparkle rewrites it on demand.
 */
export function RecordSummary({ entity, id, summary: initialSummary, summaryAt: initialAt }: { entity: SummaryEntity; id: string; summary: string | null; summaryAt: Date | string | null }) {
  const { services, workspace } = useApp();
  const [summary, setSummary] = useState(initialSummary);
  const [at, setAt] = useState(initialAt ? new Date(initialAt).toISOString() : null);
  // Known on the server too, so the loading state is there from the first paint instead of popping in.
  const needsWriting = services.ai.summaries && !(initialSummary && isFresh(initialAt));
  const [working, setWorking] = useState(needsWriting);
  const [failed, setFailed] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!needsWriting) return;
    let live = true;
    recordSummary(entity, id).then((r) => {
      if (!live) return;
      setWorking(false);
      if (!r.ok) return setFailed(r.error);
      if (r.data.summary) {
        setSummary(r.data.summary);
        setAt(r.data.summaryAt);
      }
    });
    return () => {
      live = false;
    };
  }, [entity, id, needsWriting]);

  const refresh = async () => {
    if (working) return;
    setWorking(true);
    setFailed("");
    const r = await recordSummary(entity, id, true);
    setWorking(false);
    if (!r.ok) {
      // With a summary on screen it stays; the toast says why it wasn't rewritten.
      if (summary) toast.error(r.error);
      else setFailed(r.error);
      return;
    }
    if (r.data.summary) {
      setSummary(r.data.summary);
      setAt(r.data.summaryAt);
    }
  };

  // Summaries switched off on this deployment: nothing shows, not even an old one.
  if (!appConfig.agent.summaries) return null;
  if (!summary && !working && (!services.ai.summaries || !failed)) return null;
  const canRefresh = services.ai.summaries && (!!summary || !!failed);

  return (
    <section aria-label="AI summary" className={clsx("relative rounded-xl border border-line bg-surface px-4 pt-3", working ? "pb-7" : "pb-3.5")}>
      <div className="flex items-stretch gap-2.5">
        {/* The sparkle at the top, refresh pinned to the bottom of the same column. */}
        <div className="flex shrink-0 flex-col items-center justify-between gap-2">
          <SparklesIcon className="mt-0.5 size-4 text-muted" aria-hidden />
          {canRefresh ? (
            <button
              type="button"
              onClick={refresh}
              disabled={working}
              aria-label="Refresh summary"
              title={working ? "Summarizing…" : at ? `Summarized ${formatAgo(at, workspace.timezone)}. Refresh to write it again from the latest on this record.` : "Write the summary again"}
              className="-m-1 flex size-6 items-center justify-center rounded-md text-faint hover:bg-sunken hover:text-secondary disabled:pointer-events-none pointer-coarse:size-8 pointer-coarse:-m-2"
            >
              <ArrowPathIcon className={clsx("size-4", working && "animate-spin")} aria-hidden />
            </button>
          ) : null}
        </div>
        {summary ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            title={at ? `Summarized ${formatAgo(at, workspace.timezone)}. Click to ${open ? "collapse" : "read it all"}.` : undefined}
            className={clsx("min-w-0 flex-1 text-left text-[13.5px] leading-[1.55] text-secondary", !open && "line-clamp-6 sm:line-clamp-4", working && "opacity-80")}
          >
            {summary}
          </button>
        ) : working ? (
          <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1" aria-hidden>
            <div className="h-3 w-full animate-pulse rounded bg-sunken" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-sunken" />
          </div>
        ) : (
          <p className="min-w-0 flex-1 text-[13px] text-muted">{failed || "No summary yet."}</p>
        )}
      </div>
      {working ? (
        <span className="absolute right-3 bottom-1.5 inline-flex items-center gap-1.5 rounded-full bg-surface pl-1.5 text-[11.5px] text-muted" role="status">
          <Spinner className="size-3" />
          {summary ? "Re-summarizing…" : "Summarizing…"}
        </span>
      ) : null}
    </section>
  );
}
