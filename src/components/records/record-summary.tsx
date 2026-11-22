"use client";

import clsx from "clsx";
import { useEffect, useState } from "react";
import { SparklesIcon } from "@heroicons/react/24/outline";
import { recordSummary } from "@/actions/agent";
import { appConfig } from "@/app.config";
import { useApp } from "@/components/app-context";
import { Spinner } from "@/components/ui/button";
import { formatAgo } from "@/lib/format";
import { isFresh, type SummaryEntity } from "@/lib/agent/summary-prompt";

/**
 * The AI snapshot at the top of a record: who they are, the latest that
 * matters, what needs attention. Shown straight from the record; when it's
 * missing or more than a day old, a new one is written while the old one
 * stays on screen, with "Re-summarizing…" in the corner.
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

  // Summaries switched off on this deployment: nothing shows, not even an old one.
  if (!appConfig.agent.summaries) return null;
  if (!summary && !working && (!services.ai.summaries || !failed)) return null;

  return (
    <section aria-label="AI summary" className={clsx("relative rounded-xl border border-line bg-surface px-4 pt-3", working ? "pb-7" : "pb-3.5")}>
      <div className="flex items-start gap-2.5">
        <SparklesIcon className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
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
