import type { Metadata } from "next";
import { Suspense } from "react";
import { z } from "zod";
import { CalendarView } from "@/components/calendar/calendar-view";
import { PageSkeleton } from "@/components/ui/skeleton";
import { requireUser } from "@/lib/auth";
import { calendarRange } from "@/lib/calendar";
import { mondayOf, monthGrid, monthOf } from "@/lib/calendar-week";
import { getAppData } from "@/lib/crm/context";
import { viewerTimeZone } from "@/lib/viewer-time-zone";
import { dayKey } from "@/lib/format";

export const metadata: Metadata = { title: "Calendar" };

export default function CalendarPage({ searchParams }: PageProps<"/calendar">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Calendar searchParams={searchParams} />
    </Suspense>
  );
}

async function Calendar({ searchParams }: Pick<PageProps<"/calendar">, "searchParams">) {
  const user = await requireUser("/calendar");
  const app = await getAppData();
  const params = await searchParams;
  const tz = await viewerTimeZone(app.workspace.timezone);
  const day = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((v) => !Number.isNaN(Date.parse(`${v}T12:00:00Z`)))
    .catch(dayKey(new Date(), tz))
    .parse(params.date ?? params.week);
  // The URL wins; otherwise the view they last used.
  const view = params.view === "month" || params.view === "week" ? params.view : (user.prefs.calendarView ?? "week");
  const days = view === "month" ? monthGrid(day) : null;
  const from = days ? days[0] : mondayOf(day);
  const active = new Set(app.team.filter((m) => m.active).map((m) => m.id));
  const asked = typeof params.people === "string" ? params.people.split(",") : (user.prefs.calendarPeople ?? [user.id]);
  const userIds = asked.filter((id) => active.has(id)).slice(0, 20);
  const data = await calendarRange({ from, days: days?.length ?? 7, userIds, viewerId: user.id, timezone: tz });
  return <CalendarView view={view} anchor={view === "month" ? monthOf(day) : from} userIds={userIds} data={data} />;
}
