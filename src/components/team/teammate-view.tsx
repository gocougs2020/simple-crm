"use client";

import Link from "next/link";
import { CheckCircleIcon, ChevronRightIcon, EnvelopeIcon } from "@heroicons/react/20/solid";
import { useApp } from "@/components/app-context";
import { ActivityItem, PlannedItem } from "@/components/activity/timeline";
import { Avatar } from "@/components/ui/avatar";
import { StatusBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import type { ActivityRow } from "@/lib/crm/activities";
import type { Teammate } from "@/lib/crm/teammates";
import { roleLabels, type ClientCategory, type UserRole } from "@/lib/constants";
import { formatAgo } from "@/lib/format";

type Owned = {
  clients: Partial<Record<ClientCategory, number>>;
  people: number;
  organizations: number;
  list: { id: string; name: string; category: ClientCategory; value: number; stageName: string }[];
};

/** No record is being viewed, so every activity shows what it's linked to. */
const anywhere = { type: "person" as const, id: "" };

/**
 * A teammate's page, for the rest of the team: who they are, what's on their
 * plate, what they did lately and which records are theirs. Opened from a
 * mention, the team list or anywhere their name links.
 */
export function TeammateView({ teammate: t, planned, plannedCount, overdue, recent, owned }: { teammate: Teammate; planned: ActivityRow[]; plannedCount: number; overdue: number; recent: ActivityRow[]; owned: Owned }) {
  const { viewer, workspace, money } = useApp();
  const you = t.id === viewer.id;
  const first = t.name.split(" ")[0];
  // Name the tab, or the Clients page opens the one this viewer last used; the table shows every pipeline, where the board shows one.
  const prospects = owned.clients.prospective ?? 0;
  const current = owned.clients.current ?? 0;
  const clientsHref = `/clients?owner=${t.id}&category=${!prospects && current ? "current" : "prospective"}&view=table`;
  const status = t.deactivatedAt ? <StatusBadge>Deactivated</StatusBadge> : t.invited ? <StatusBadge tone="warning">Invite sent</StatusBadge> : null;
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-6 lg:px-6">
      <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1 text-[12.5px] text-muted max-lg:hidden">
        <Link href="/settings/team" className="hover:text-primary">
          Team
        </Link>
        <ChevronRightIcon className="size-3.5 text-faint" aria-hidden />
        <span className="truncate text-secondary">{t.name}</span>
      </nav>
      <header className="flex flex-wrap items-center gap-3">
        <Avatar name={t.name} size="xl" />
        <div className="min-w-0 flex-1">
          <h1 className="flex flex-wrap items-center gap-2 text-page-title break-words">
            {t.name}
            {you ? <span className="text-[15px] font-normal text-muted">(you)</span> : null}
            {status}
          </h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[13px] text-muted">
            {[t.title, roleLabels[t.role as UserRole]].filter(Boolean).join(" · ")}
            {t.lastSeenAt && !t.deactivatedAt ? (
              <span suppressHydrationWarning>· Active {formatAgo(t.lastSeenAt, workspace.timezone)}</span>
            ) : null}
          </p>
        </div>
        <a href={`mailto:${t.email}`} className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-md max-sm:basis-full max-sm:justify-center pointer-coarse:h-10 border border-line px-3 text-[13px] font-medium text-secondary hover:border-line-strong hover:text-primary">
          <EnvelopeIcon className="size-4 shrink-0 text-muted" aria-hidden />
          <span className="truncate">{t.email}</span>
        </a>
      </header>

      <dl className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Open tasks and plans" value={plannedCount} detail={overdue ? `${overdue} overdue` : undefined} tone={overdue ? "warn" : undefined} href={`/activities?who=${t.id}`} />
        <Stat label="Clients they own" value={prospects + current} detail={`${prospects} prospects, ${current} current`} href={clientsHref} />
        <Stat label="People they own" value={owned.people} href={`/people?owner=${t.id}`} />
        <Stat label="Organizations they own" value={owned.organizations} href={`/organizations?owner=${t.id}`} />
      </dl>

      <div className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="flex min-w-0 flex-col gap-6">
          <section aria-labelledby="planned">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h2 id="planned" className="text-section">
                Coming up for {you ? "you" : first}
              </h2>
              {plannedCount ? (
                <Link href={`/activities?who=${t.id}`} className="text-[12.5px] text-muted hover:text-primary">
                  {plannedCount > planned.length ? `All ${plannedCount}` : "Open in Activities"}
                </Link>
              ) : null}
            </div>
            {planned.length ? (
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                {planned.map((row) => (
                  <PlannedItem key={row.activity.id} row={row} context={anywhere} />
                ))}
              </ul>
            ) : (
              <EmptyState variant="subtle" icon={CheckCircleIcon} title="Nothing planned" description={`Tasks, calls and meetings assigned to ${you ? "you" : first} show up here.`} />
            )}
          </section>

          <section aria-labelledby="recent">
            <h2 id="recent" className="mb-2 text-section">
              Recent activity
            </h2>
            {recent.length ? (
              <ol className="relative flex flex-col gap-2 before:absolute before:top-2 before:bottom-2 before:left-[15px] before:w-px before:bg-line">
                {recent.map((row) => (
                  <ActivityItem key={row.activity.id} row={row} context={anywhere} />
                ))}
              </ol>
            ) : (
              <EmptyState variant="subtle" title="No activity yet" description={`Notes, calls, meetings and email ${you ? "you log" : `${first} logs`} show up here.`} />
            )}
          </section>
        </div>

        <aside className="flex min-w-0 flex-col gap-6">
          <section aria-labelledby="clients" className="rounded-xl border border-line bg-surface p-4">
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <h2 id="clients" className="text-[13px] font-semibold text-primary">
                Their clients
              </h2>
              <Link href={clientsHref} className="text-[12.5px] text-muted hover:text-primary">
                See all
              </Link>
            </div>
            <p className="text-[12px] text-muted">Prospects and current clients they own, most recently moved first.</p>
            {owned.list.length ? (
              <ul className="-mx-2 mt-2">
                {owned.list.map((c) => (
                  <li key={c.id}>
                    <Link href={`/clients/${c.id}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sunken">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-primary">{c.name}</span>
                        <span className="block truncate text-[11.5px] text-muted">{[c.category === "current" ? "Current" : "Prospect", c.stageName].join(" · ")}</span>
                      </span>
                      {c.category === "prospective" && c.value ? <span className="text-[12px] text-secondary tabular-nums">{money(c.value, { compact: true })}</span> : null}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[12.5px] text-muted">{you ? "You don't" : `${first} doesn't`} own any prospects or current clients yet.</p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value, detail, tone, href }: { label: string; value: number; detail?: string; tone?: "warn"; href: string }) {
  return (
    <div className="relative rounded-xl border border-line bg-surface px-4 py-3 hover:border-line-strong">
      <dt className="text-[12px] text-muted">
        {/* The whole tile opens the filtered list. */}
        <Link href={href} className="after:absolute after:inset-0 after:rounded-xl">
          {label}
        </Link>
      </dt>
      <dd className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
        <span className="text-[22px] font-semibold tracking-tight text-primary tabular-nums">{value.toLocaleString()}</span>
        {detail ? <span className={tone === "warn" ? "text-[12px] font-medium text-error" : "text-[12px] text-muted"}>{detail}</span> : null}
      </dd>
    </div>
  );
}
