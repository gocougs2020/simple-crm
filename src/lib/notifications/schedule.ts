import { appConfig } from "@/app.config";
import type { EmailDigestKind } from "@/lib/constants";

/**
 * When scheduled notifications go out. Pure (tested): the quarter-hour cron
 * calls these with the current time and the workspace's time zone.
 */

/** A meeting or timed task is announced in the run up to 15 minutes before it, or by a run up to 5 minutes late. */
export const LEAD_MS = 15 * 60_000;
export const GRACE_MS = 5 * 60_000;

/** Morning things go out from the configured hour, and for 4 hours after in case the cron missed a run. */
const MORNING_WINDOW_HOURS = 4;

export const morningHour = () => Math.min(23, Math.max(0, Math.round(Number(appConfig.notifications.morningHour) || 0)));

/** The hour and weekday (1 = Monday … 7 = Sunday) in a time zone. */
export function localClock(now: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.find((p) => p.type === "weekday")?.value ?? "") + 1;
  return { hour, weekday };
}

export function isMorning(now: Date, tz: string, start = morningHour()) {
  const { hour } = localClock(now, tz);
  return hour >= start && hour < start + MORNING_WINDOW_HOURS;
}

/**
 * Which agenda email a teammate gets this morning, if any: the weekly one on
 * Mondays, the daily one on weekdays. On a Monday with both on, only the
 * weekly one goes out, since it already covers today.
 */
export function agendaFor(now: Date, tz: string, wants: Partial<Record<EmailDigestKind, boolean>> | undefined, start = morningHour()): EmailDigestKind | null {
  if (!wants || !isMorning(now, tz, start)) return null;
  const { weekday } = localClock(now, tz);
  if (weekday === 1 && wants.weekly) return "weekly";
  if (weekday >= 1 && weekday <= 5 && wants.daily) return "daily";
  return null;
}

/** Whether something starting at `at` should be announced by a run at `now`. */
export const dueForReminder = (at: Date, now: Date) => at.getTime() > now.getTime() - GRACE_MS && at.getTime() <= now.getTime() + LEAD_MS;
