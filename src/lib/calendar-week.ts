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

/** The first of the month a YYYY-MM-DD falls in. */
export function monthOf(ymd: string) {
  return `${ymd.slice(0, 7)}-01`;
}

/** The first of the month `months` before or after a YYYY-MM-DD's month. */
export function addMonths(ymd: string, months: number) {
  const d = new Date(`${monthOf(ymd)}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

/**
 * The days a month grid shows: whole weeks, Monday to Sunday, from the week
 * the 1st falls in to the week the last day falls in (35 or 42 days, 28 for a
 * February that starts on a Monday).
 */
export function monthGrid(ymd: string) {
  const first = monthOf(ymd);
  const last = addDays(addMonths(first, 1), -1);
  const start = mondayOf(first);
  const end = addDays(mondayOf(last), 6);
  const days: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return days;
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
