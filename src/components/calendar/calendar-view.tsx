"use client";

import clsx from "clsx";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/20/solid";
import { PhoneIcon, UsersIcon } from "@heroicons/react/24/outline";
import { savePrefs } from "@/actions/records";
import { useApp } from "@/components/app-context";
import { PageHeader } from "@/components/shell/app-shell";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/menu";
import type { CalendarWeek } from "@/lib/calendar";
import { addDays, daysCovered, weekDays } from "@/lib/calendar-week";
import { dayKey, formatTime } from "@/lib/format";

type Item = {
  key: string;
  userId: string | null;
  title: string;
  start: string;
  end: string | null;
  allDay: boolean;
  hasTime: boolean;
  href: string | null;
  who: string | null;
  source: "crm" | "outlook";
  kind: "meeting" | "call" | "event" | "busy";
  done?: boolean;
  location?: string | null;
};

/**
 * Calendar: the week for the teammates picked, day by day. CRM meetings and
 * planned calls link to their record; Outlook events show as much as each
 * teammate shares (titles, or just busy).
 */
export function CalendarView({ monday, userIds, data }: { monday: string; userIds: string[]; data: CalendarWeek }) {
  const { workspace, team, viewer, member, comms } = useApp();
  const router = useRouter();
  const [pending, start] = useTransition();
  const tz = workspace.timezone;
  const days = weekDays(monday);
  const today = dayKey(new Date(), tz);
  const color = new Map(userIds.map((id, i) => [id, i]));

  const go = (week: string, people = userIds) =>
    start(() => {
      router.push(`/calendar?week=${week}&people=${people.join(",")}`);
    });
  const togglePerson = (id: string) => {
    const next = userIds.includes(id) ? userIds.filter((x) => x !== id) : [...userIds, id];
    void savePrefs({ calendarPeople: next });
    go(monday, next);
  };

  const items: Item[] = [
    ...data.crm.map(
      (e): Item => ({
        key: e.id,
        userId: e.userId,
        title: e.subject || (e.type === "call" ? `Call${e.who ? ` with ${e.who}` : ""}` : `Meeting${e.who ? ` with ${e.who}` : ""}`),
        start: e.at,
        end: e.minutes ? new Date(new Date(e.at).getTime() + e.minutes * 60_000).toISOString() : null,
        allDay: false,
        hasTime: e.hasTime,
        href: e.href,
        who: e.who,
        source: "crm",
        kind: e.type,
        done: e.done,
      }),
    ),
    ...data.outlook.map(
      (e): Item => ({
        key: e.id,
        userId: e.userId,
        title: e.subject ?? "Busy",
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        hasTime: !e.allDay,
        href: e.href,
        who: e.who,
        source: "outlook",
        kind: e.subject ? "event" : "busy",
        location: e.location,
      }),
    ),
  ].sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));

  // All-day Outlook events are dates, not instants: they belong to the day they start in UTC.
  // Each event on every day of the week it covers: a three-day offsite is busy all three days.
  const covered = new Map(items.map((i) => [i.key, new Set(daysCovered(i, days, (iso) => dayKey(iso, tz)))]));
  const range = `${fmt(days[0])} – ${fmt(days[6], true)}`;

  return (
    <>
      <PageHeader title="Calendar" sub={<p className="mt-0.5 text-[12.5px] text-muted">{range}</p>}>
        <Button size="sm" variant="outline" onClick={() => go(addDays(monday, -7))} aria-label="Previous week">
          <ChevronLeftIcon />
        </Button>
        <Button size="sm" variant="outline" onClick={() => go(today)}>
          This week
        </Button>
        <Button size="sm" variant="outline" onClick={() => go(addDays(monday, 7))} aria-label="Next week">
          <ChevronRightIcon />
        </Button>
      </PageHeader>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2.5 lg:px-6" role="group" aria-label="Whose calendars">
        {team
          .filter((m) => m.active)
          .map((m) => {
            const on = userIds.includes(m.id);
            return (
              <button key={m.id} type="button" aria-pressed={on} onClick={() => togglePerson(m.id)} className="rounded-full">
                <Tag className={clsx("gap-1.5", on ? "border-accent bg-accent-soft text-primary" : "hover:border-line-strong")}>
                  {on ? <span className={clsx("size-2 rounded-full", dot(color.get(m.id) ?? 0))} aria-hidden /> : null}
                  {m.id === viewer.id ? "Me" : m.name}
                </Tag>
              </button>
            );
          })}
        {!comms.microsoft ? null : <span className="ml-auto text-[12px] text-muted">Outlook calendars show for teammates who connected and share theirs.</span>}
      </div>
      {data.errors.length ? (
        <p className="border-b border-warning-border bg-warning-surface px-6 py-2 text-[13px] text-warning">
          Couldn&apos;t read {data.errors.map((e) => member(e.userId)?.name ?? "a calendar").join(", ")}&apos;s Outlook calendar. {data.errors[0].message}
        </p>
      ) : null}
      <div className={clsx("grid gap-px bg-line md:grid-cols-7", pending && "opacity-60")}>
        {days.map((d) => {
          const list = items.filter((i) => covered.get(i.key)?.has(d));
          return (
            <section key={d} aria-label={fmt(d, true)} className={clsx("bg-canvas p-2 md:min-h-40", d === today && "bg-surface")}>
              <h2 className={clsx("mb-2 flex items-baseline gap-1.5 px-1 text-[12.5px] font-semibold", d === today ? "text-primary" : "text-secondary")}>
                <span>{new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })}</span>
                <span className={clsx("tabular-nums", d === today && "rounded-full bg-accent px-1.5 text-accent-foreground")}>{Number(d.slice(8))}</span>
              </h2>
              {list.length ? (
                <ul className="flex flex-col gap-1.5">
                  {list.map((i) => (
                    <li key={i.key}>
                      <EventCard item={i} tz={tz} colorIndex={i.userId ? (color.get(i.userId) ?? 0) : 0} owner={userIds.length > 1 ? member(i.userId)?.name : undefined} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-1 text-[12px] text-faint">Nothing</p>
              )}
            </section>
          );
        })}
      </div>
      {!userIds.length ? <p className="px-6 py-6 text-[13px] text-muted">Pick whose calendars to show above.</p> : null}
    </>
  );
}

function EventCard({ item, tz, colorIndex, owner }: { item: Item; tz: string; colorIndex: number; owner?: string }) {
  const Icon = item.kind === "call" ? PhoneIcon : UsersIcon;
  const time = item.allDay ? "All day" : item.hasTime ? `${formatTime(item.start, tz)}${item.end ? `–${formatTime(item.end, tz)}` : ""}` : "Any time";
  const body = (
    <span className={clsx("flex flex-col gap-0.5 rounded-md border-l-[3px] px-2 py-1.5 text-[12.5px]", bar(colorIndex), item.kind === "busy" ? "bg-sunken" : "bg-surface shadow-sm", item.href && "hover:bg-sunken")}>
      <span className="flex items-center gap-1 text-[11.5px] text-muted tabular-nums">
        {item.source === "crm" ? <Icon className="size-3.5 shrink-0" aria-label={item.kind === "call" ? "Call" : "Meeting"} /> : null}
        {time}
      </span>
      <span className={clsx("font-medium", item.kind === "busy" ? "text-muted" : "text-primary", item.done && "text-secondary")}>{item.title}</span>
      {item.who && item.source === "outlook" ? <span className="truncate text-[11.5px] text-secondary">With {item.who}</span> : null}
      {item.location ? <span className="truncate text-[11.5px] text-muted">{item.location}</span> : null}
      {owner ? (
        <span className="flex items-center gap-1 text-[11.5px] text-muted">
          <Avatar name={owner} size="xs" />
          {owner}
        </span>
      ) : null}
    </span>
  );
  const labelled = item.source === "outlook" ? <Tooltip content="From Outlook">{body}</Tooltip> : body;
  return item.href ? (
    <Link href={item.href} className="block rounded-md">
      {labelled}
    </Link>
  ) : (
    labelled
  );
}

function fmt(ymd: string, withYear = false) {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
}

/** Teammates are told apart by a few theme colors, in the order they're picked. */
const palette = ["accent", "info", "success", "warning", "error", "neutral"] as const;
const dot = (i: number) => ({ accent: "bg-accent", info: "bg-info", success: "bg-success", warning: "bg-warning", error: "bg-error", neutral: "bg-neutral" })[palette[i % palette.length]];
const bar = (i: number) => ({ accent: "border-accent", info: "border-info", success: "border-success", warning: "border-warning", error: "border-error", neutral: "border-neutral" })[palette[i % palette.length]];
