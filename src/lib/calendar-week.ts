/**
 * The week a calendar shows, in the workspace's time zone. Pure, shared by
 * the page and the browser.
 */

/** Adds days to a YYYY-MM-DD. */
export function addDays(ymd: string, days: number) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The Monday of the week a YYYY-MM-DD falls in. */
export function mondayOf(ymd: string) {
  const day = new Date(`${ymd}T12:00:00Z`).getUTCDay();
  return addDays(ymd, -((day + 6) % 7));
}

/** The seven days of the week starting on `monday`. */
export function weekDays(monday: string) {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/**
 * The days of `week` an event covers, so a multi-day event shows on each of
 * them (and one that began before the week still shows). All-day events are
 * dates, end exclusive; timed events use their instants in the time zone.
 * `dayOf` turns an instant into YYYY-MM-DD in the workspace's time zone.
 */
export function daysCovered(e: { start: string; end: string | null; allDay: boolean }, week: string[], dayOf: (iso: string) => string) {
  const first = e.allDay ? e.start.slice(0, 10) : dayOf(e.start);
  let last = first;
  if (e.end) {
    if (e.allDay) last = addDays(e.end.slice(0, 10), -1);
    // An event ending exactly at midnight doesn't cover the next day.
    else last = dayOf(new Date(new Date(e.end).getTime() - 1).toISOString());
  }
  if (last < first) last = first;
  return week.filter((d) => d >= first && d <= last);
}
