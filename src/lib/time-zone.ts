/**
 * Times show in each teammate's own time zone. The browser saves its zone in
 * this cookie (src/components/time-zone-sync.tsx) and the server renders with
 * it (`viewerTimeZone`), so pages and the components in them agree. Background
 * work (agendas, reminders, scheduled jobs, the agent) keeps the workspace's zone.
 */
export const TIME_ZONE_COOKIE = "tz";

/** Whether `tz` is a time zone this runtime knows ("America/Denver"). */
export function isTimeZone(tz: string | null | undefined): tz is string {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
