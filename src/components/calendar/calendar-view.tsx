"use client";

import clsx from "clsx";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/20/solid";
import { PhoneIcon, UsersIcon } from "@heroicons/react/24/outline";
import { savePrefs } from "@/actions/records";
import { Segmented } from "@/components/activity/composer";
import { useApp } from "@/components/app-context";
import { PageHeader } from "@/components/shell/app-shell";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Tag } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/menu";
import type { CalendarData } from "@/lib/calendar";
import { addDays, addMonths, daysCovered, monthGrid, weekDays } from "@/lib/calendar-week";
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
 * Calendar: the week or the month for the teammates picked. CRM meetings and
 * planned calls link to their record; Outlook events show as much as each
 * teammate shares (titles, or just busy), the viewer's own in full. In the
 * month, a day shows its first few and opens to show them all.
 */
export function CalendarView({ view, anchor, userIds, data }: { view: "week" | "month"; /** The Monday shown (week) or the first of the month. */ anchor: string; userIds: string[]; data: CalendarData }) {
  const { workspace, team, viewer, member, comms } = useApp();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [openDay, setOpenDay] = useState<string | null>(null);
  const tz = workspace.timezone;
  const days = view === "month" ? monthGrid(anchor) : weekDays(anchor);
  const today = dayKey(new Date(), tz);
  const color = new Map(userIds.map((id, i) => [id, i]));

  const go = (next: { view?: "week" | "month"; date?: string; people?: string[] }) =>
    start(() => {
      const v = next.view ?? view;
      router.push(`/calendar?view=${v}&date=${next.date ?? anchor}&people=${(next.people ?? userIds).join(",")}`);
    });
  const togglePerson = (id: string) => {
    const next = userIds.includes(id) ? userIds.filter((x) => x !== id) : [...userIds, id];
    void savePrefs({ calendarPeople: next });
    go({ people: next });
  };
  const switchView = (v: "week" | "month") => {
    void savePrefs({ calendarView: v });
    // The week keeps today in view when it's in the month shown, else the month's first week.
    // The month is the one the week's Thursday is in, so a week starting Nov 30 opens December.
    const date = v === "week" ? (today.slice(0, 7) === anchor.slice(0, 7) ? today : anchor) : view === "week" ? addDays(anchor, 3) : anchor;
    go({ view: v, date });
  };
  const step = (n: number) => go({ date: view === "month" ? addMonths(anchor, n) : addDays(anchor, 7 * n) });

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
  // Each event on every day it covers: a three-day offsite is busy all three days.
  const covered = new Map(items.map((i) => [i.key, new Set(daysCovered(i, days, (iso) => dayKey(iso, tz)))]));
  const on = (d: string) => items.filter((i) => covered.get(i.key)?.has(d));
  const range = view === "month" ? monthName(anchor) : `${fmt(days[0])} – ${fmt(days[6], true)}`;
  const current = view === "month" ? today.slice(0, 7) === anchor.slice(0, 7) : days.includes(today);
  const card = (i: Item) => <EventCard item={i} tz={tz} colorIndex={i.userId ? (color.get(i.userId) ?? 0) : 0} owner={userIds.length > 1 ? member(i.userId)?.name : undefined} />;

  return (
    <>
      <PageHeader title="Calendar" sub={<p className="mt-0.5 text-[12.5px] text-muted">{range}</p>}>
        <Segmented
          value={view}
          onChange={switchView}
          options={[
            { value: "week", label: "Week" },
            { value: "month", label: "Month" },
          ]}
        />
        <Button size="sm" variant="outline" onClick={() => step(-1)} aria-label={view === "month" ? "Previous month" : "Previous week"}>
          <ChevronLeftIcon />
        </Button>
        <Button size="sm" variant="outline" onClick={() => go({ date: today })} disabled={current}>
          {view === "month" ? "This month" : "This week"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => step(1)} aria-label={view === "month" ? "Next month" : "Next week"}>
          <ChevronRightIcon />
        </Button>
      </PageHeader>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2.5 lg:px-6" role="group" aria-label="Whose calendars">
        {team
          .filter((m) => m.active)
          .map((m) => {
            const picked = userIds.includes(m.id);
            return (
              <button key={m.id} type="button" aria-pressed={picked} onClick={() => togglePerson(m.id)} className="rounded-full">
                <Tag className={clsx("gap-1.5", picked ? "border-accent bg-accent-soft text-primary" : "hover:border-line-strong")}>
                  {picked ? <span className={clsx("size-2 rounded-full", dot(color.get(m.id) ?? 0))} aria-hidden /> : null}
                  {m.id === viewer.id ? "Me" : m.name}
                </Tag>
              </button>
            );
          })}
        {!comms.microsoft ? null : <span className="ml-auto text-[12px] text-muted">Your Outlook calendar shows with your meetings. Teammates&apos; show when they connected and share theirs.</span>}
      </div>
      {data.errors.length ? (
        <p className="border-b border-warning-border bg-warning-surface px-6 py-2 text-[13px] text-warning">
          Couldn&apos;t read {data.errors.map((e) => member(e.userId)?.name ?? "a calendar").join(", ")}&apos;s Outlook calendar. {data.errors[0].message}
        </p>
      ) : null}
      {view === "week" ? (
        <div className={clsx("grid gap-px bg-line md:grid-cols-7", pending && "opacity-60")}>
          {days.map((d) => {
            const list = on(d);
            return (
              <section key={d} aria-label={fmt(d, true)} className={clsx("bg-canvas p-2 md:min-h-40", d === today && "bg-surface")}>
                <h2 className={clsx("mb-2 flex items-baseline gap-1.5 px-1 text-[12.5px] font-semibold", d === today ? "text-primary" : "text-secondary")}>
                  <span>{weekday(d)}</span>
                  <span className={clsx("tabular-nums", d === today && "rounded-full bg-accent px-1.5 text-accent-foreground")}>{Number(d.slice(8))}</span>
                </h2>
                {list.length ? (
                  <ul className="flex flex-col gap-1.5">
                    {list.map((i) => (
                      <li key={i.key}>{card(i)}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-1 text-[12px] text-faint">Nothing</p>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <div className={clsx(pending && "opacity-60")}>
          <div className="grid grid-cols-7 border-b border-line bg-canvas" aria-hidden>
            {days.slice(0, 7).map((d) => (
              <span key={d} className="px-2 py-1.5 text-[11.5px] font-semibold text-muted">
                {weekday(d)}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-px bg-line">
            {days.map((d) => {
              const list = on(d);
              const inMonth = d.slice(0, 7) === anchor.slice(0, 7);
              const shown = list.slice(0, MONTH_PER_DAY);
              return (
                <section
                  key={d}
                  aria-label={fmt(d, true)}
                  // A click anywhere on the day opens it; the day number is the button for keyboards and screen readers.
                  onClick={(e) => {
                    if (!(e.target as HTMLElement).closest("a,button")) setOpenDay(d);
                  }}
                  className={clsx("flex min-h-20 min-w-0 cursor-pointer flex-col gap-1 p-1 hover:bg-sunken md:min-h-28 md:p-1.5", d === today ? "bg-surface" : inMonth ? "bg-canvas" : "bg-sunken/60")}
                >
                  <button
                    type="button"
                    onClick={() => setOpenDay(d)}
                    aria-label={`${fmt(d, true)}: ${list.length ? `${list.length} ${list.length === 1 ? "item" : "items"}` : "nothing"}. Show the day`}
                    className={clsx(
                      "self-start rounded-full px-1.5 text-[12px] font-semibold tabular-nums",
                      d === today ? "bg-accent text-accent-foreground" : inMonth ? "text-secondary hover:bg-surface" : "text-faint hover:bg-surface",
                    )}
                  >
                    {Number(d.slice(8))}
                  </button>
                  {/* Phones: a dot per item (up to a few), the day opens to show them. */}
                  {list.length ? (
                    <span className="flex flex-wrap gap-0.5 px-1 md:hidden" aria-hidden>
                      {list.slice(0, 4).map((i) => (
                        <span key={i.key} className={clsx("size-1.5 rounded-full", i.kind === "busy" ? "bg-neutral" : dot(i.userId ? (color.get(i.userId) ?? 0) : 0))} />
                      ))}
                    </span>
                  ) : null}
                  <ul className="flex min-w-0 flex-col gap-0.5 max-md:hidden">
                    {shown.map((i) => (
                      <li key={i.key} className="min-w-0">
                        <CompactEvent item={i} tz={tz} colorIndex={i.userId ? (color.get(i.userId) ?? 0) : 0} />
                      </li>
                    ))}
                  </ul>
                  {list.length > shown.length ? (
                    <button type="button" onClick={() => setOpenDay(d)} className="self-start rounded px-1 text-[11.5px] font-medium text-muted hover:bg-surface hover:text-primary max-md:hidden">
                      {list.length - shown.length} more
                    </button>
                  ) : null}
                </section>
              );
            })}
          </div>
        </div>
      )}
      {!userIds.length ? <p className="px-6 py-6 text-[13px] text-muted">Pick whose calendars to show above.</p> : null}
      <Dialog open={!!openDay} onOpenChange={(o) => !o && setOpenDay(null)} title={openDay ? longDay(openDay) : ""} size="md">
        {openDay ? (
          <div className="flex flex-col gap-3">
            {on(openDay).length ? (
              <ul className="flex flex-col gap-1.5">
                {on(openDay).map((i) => (
                  <li key={i.key}>{card(i)}</li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted">Nothing on this day.</p>
            )}
            <div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const d = openDay;
                  setOpenDay(null);
                  void savePrefs({ calendarView: "week" });
                  go({ view: "week", date: d });
                }}
              >
                See the week
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </>
  );
}

/** How many items a day shows in the month before "N more". */
const MONTH_PER_DAY = 3;

/** One line in a month day: the teammate's color, the time and the title. */
function CompactEvent({ item, tz, colorIndex }: { item: Item; tz: string; colorIndex: number }) {
  const time = item.allDay ? null : item.hasTime ? formatTime(item.start, tz) : null;
  const body = (
    <span className={clsx("flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-[11.5px] leading-4", item.kind === "busy" ? "text-muted" : "text-primary", item.href && "hover:bg-surface", item.allDay && "bg-surface")}>
      <span className={clsx("size-1.5 shrink-0 rounded-full", item.kind === "busy" ? "bg-neutral" : dot(colorIndex))} aria-hidden />
      {time ? <span className="shrink-0 text-muted tabular-nums">{time}</span> : null}
      <span className={clsx("truncate", item.done && "text-secondary")}>{item.title}</span>
    </span>
  );
  const labelled = item.source === "outlook" ? <Tooltip content="From Outlook">{body}</Tooltip> : body;
  return item.href ? (
    <Link href={item.href} className="block min-w-0 rounded">
      {labelled}
    </Link>
  ) : (
    labelled
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

const weekday = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
const longDay = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const monthName = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

function fmt(ymd: string, withYear = false) {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
}

/** Teammates are told apart by a few theme colors, in the order they're picked. */
const palette = ["accent", "info", "success", "warning", "error", "neutral"] as const;
const dot = (i: number) => ({ accent: "bg-accent", info: "bg-info", success: "bg-success", warning: "bg-warning", error: "bg-error", neutral: "bg-neutral" })[palette[i % palette.length]];
const bar = (i: number) => ({ accent: "border-accent", info: "border-info", success: "border-success", warning: "border-warning", error: "border-error", neutral: "border-neutral" })[palette[i % palette.length]];
