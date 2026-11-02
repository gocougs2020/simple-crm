"use client";

import Link from "next/link";
import { CheckCircleIcon, ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { useApp } from "@/components/app-context";
import { ActivityItem, PlannedItem } from "@/components/activity/timeline";
import { Avatar } from "@/components/ui/avatar";
import { EmptyState } from "@/components/ui/empty-state";
import type { ActivityRow } from "@/lib/crm/activities";
import type { ClientCategory } from "@/lib/constants";
import { daysSince } from "@/lib/format";

type Stuck = { id: string; name: string; category: ClientCategory; value: number; ownerId: string | null; stageChangedAt: Date; organizationName: string | null };
type Stats = { prospectCount: number; prospectValue: number; currentCount: number; mrr: number; signedThisMonth: number; leftThisMonth: number; dueNow: number };
type StageSummary = { id: string; name: string; n: number; value: number };

/** No record is being viewed, so every activity shows what it's linked to. */
const anywhere = { type: "person" as const, id: "" };

export function HomeView({
  greeting,
  tasks,
  feed,
  stuck,
  stats,
  stages,
  pipelineName,
}: {
  greeting: string;
  tasks: ActivityRow[];
  feed: ActivityRow[];
  stuck: Stuck[];
  stats: Stats;
  stages: StageSummary[];
  pipelineName: string | null;
}) {
  const { viewer, money, member } = useApp();
  const max = Math.max(1, ...stages.map((s) => s.value));
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-6 lg:px-6">
      <h1 className="text-page-title">
        {greeting}, {viewer.name.split(" ")[0]}
      </h1>
      <dl className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Due today or overdue" value={stats.dueNow.toLocaleString()} tone={stats.dueNow ? "warn" : undefined} />
        <Stat label="Prospects" value={stats.prospectCount.toLocaleString()} detail={`${money(stats.prospectValue, { compact: true })} potential`} />
        <Stat label="Current clients" value={stats.currentCount.toLocaleString()} detail={`${money(stats.mrr, { compact: stats.mrr >= 1e8 })}/mo`} />
        <Stat
          label="This month"
          value={`${stats.signedThisMonth} signed`}
          detail={stats.leftThisMonth ? `${stats.leftThisMonth} left` : undefined}
        />
      </dl>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-6">
          <section aria-labelledby="my-tasks">
            <div className="mb-2 flex items-baseline justify-between">
              <h2 id="my-tasks" className="text-section">
                Your next 7 days
              </h2>
              <Link href="/activities" className="text-[12.5px] text-muted hover:text-primary">
                All activities
              </Link>
            </div>
            {tasks.length ? (
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                {tasks.map((row) => (
                  <PlannedItem key={row.activity.id} row={row} context={anywhere} />
                ))}
              </ul>
            ) : (
              <EmptyState variant="subtle" icon={CheckCircleIcon} title="You're all caught up" description="Nothing due in the next 7 days. Schedule follow-ups from any record." />
            )}
          </section>

          <section aria-labelledby="team-feed">
            <h2 id="team-feed" className="mb-2 text-section">
              Team activity
            </h2>
            {feed.length ? (
              <ol className="relative flex flex-col gap-2 before:absolute before:top-2 before:bottom-2 before:left-[15px] before:w-px before:bg-line">
                {feed.map((row) => (
                  <ActivityItem key={row.activity.id} row={row} context={anywhere} />
                ))}
              </ol>
            ) : (
              <EmptyState variant="subtle" title="No activity yet" description="Calls, emails and notes your team logs show up here." />
            )}
          </section>
        </div>

        <aside className="flex flex-col gap-6">
          {pipelineName ? (
            <section aria-labelledby="pipeline" className="rounded-xl border border-line bg-surface p-4">
              <div className="mb-3 flex items-baseline justify-between">
                <h2 id="pipeline" className="text-[13px] font-semibold text-primary">
                  {pipelineName} pipeline
                </h2>
                <Link href="/clients" className="text-[12.5px] text-muted hover:text-primary">
                  Open board
                </Link>
              </div>
              <ul className="flex flex-col gap-2.5">
                {stages.map((s) => (
                  <li key={s.id}>
                    <div className="flex justify-between gap-2 text-[12.5px]">
                      <span className="truncate text-secondary">{s.name}</span>
                      <span className="shrink-0 text-muted tabular-nums">
                        {s.n} · {money(s.value, { compact: s.value >= 1e8 })}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-sunken">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${(s.value / max) * 100}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="stuck" className="rounded-xl border border-line bg-surface p-4">
            <h2 id="stuck" className="flex items-center gap-1.5 text-[13px] font-semibold text-primary">
              <ExclamationTriangleIcon className="size-4 text-warning" aria-hidden />
              Clients with no next step
            </h2>
            <p className="mt-0.5 text-[12px] text-muted">Prospects and current clients with nothing planned, longest-waiting first.</p>
            {stuck.length ? (
              <ul className="-mx-2 mt-2">
                {stuck.map((d) => {
                  const owner = member(d.ownerId);
                  return (
                    <li key={d.id}>
                      <Link href={`/clients/${d.id}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sunken">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-primary">{d.name}</span>
                          <span className="block truncate text-[11.5px] text-muted">
                            {[d.category === "current" ? "Current" : "Prospect", d.organizationName !== d.name ? d.organizationName : null, `${daysSince(d.stageChangedAt)}d in stage`].filter(Boolean).join(" · ")}
                          </span>
                        </span>
                        {d.category === "prospective" && d.value ? <span className="text-[12px] text-secondary tabular-nums">{money(d.value, { compact: true })}</span> : null}
                        {owner ? <Avatar name={owner.name} size="xs" /> : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-2 text-[12.5px] text-muted">Every prospect and current client has a next step.</p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: "warn" }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="mt-0.5 flex items-baseline gap-2">
        <span className={tone === "warn" ? "text-[22px] font-semibold tracking-tight text-error tabular-nums" : "text-[22px] font-semibold tracking-tight text-primary tabular-nums"}>{value}</span>
        {detail ? <span className="text-[12px] text-muted">{detail}</span> : null}
      </dd>
    </div>
  );
}
