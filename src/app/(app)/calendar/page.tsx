import type { Metadata } from "next";
import { Suspense } from "react";
import { z } from "zod";
import { CalendarView } from "@/components/calendar/calendar-view";
import { PageSkeleton } from "@/components/ui/skeleton";
import { requireUser } from "@/lib/auth";
import { calendarWeek } from "@/lib/calendar";
import { mondayOf } from "@/lib/calendar-week";
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
  const week = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((v) => !Number.isNaN(Date.parse(`${v}T12:00:00Z`)))
    .catch(dayKey(new Date(), tz))
    .parse(params.week);
  const monday = mondayOf(week);
  const active = new Set(app.team.filter((m) => m.active).map((m) => m.id));
  const asked = typeof params.people === "string" ? params.people.split(",") : (user.prefs.calendarPeople ?? [user.id]);
  const userIds = asked.filter((id) => active.has(id)).slice(0, 20);
  const data = await calendarWeek({ monday, userIds, viewerId: user.id, timezone: tz });
  return <CalendarView monday={monday} userIds={userIds} data={data} />;
}
