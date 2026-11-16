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
