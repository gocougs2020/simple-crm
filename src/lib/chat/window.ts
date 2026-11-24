/**
 * The time window a read of the team chat covers (the API's and MCP's
 * list_chat_messages). Pure, so the rule is tested: the last 30 days unless
 * `from` / `to` say otherwise. Each is an ISO 8601 time, or a date
 * (YYYY-MM-DD) in the workspace's time zone: a `from` date starts at its
 * midnight, a `to` date runs to the end of that day.
 */

import { ActionError } from "@/lib/errors";

/** How far back a read of the chat goes when it doesn't say. */
export const DEFAULT_CHAT_DAYS = 30;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Minutes `tz` is ahead of UTC at that moment. */
function offsetMinutes(at: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return (Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(at.getTime() / 1000) * 1000) / 60_000;
}

/** Midnight at the start of a YYYY-MM-DD day in `tz`, as an instant. */
export function localMidnight(ymd: string, tz: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const first = offsetMinutes(new Date(guess), tz);
  let at = guess - first * 60_000;
  // Across a daylight-saving change the offset at midnight differs from the one at UTC midnight.
  const second = offsetMinutes(new Date(at), tz);
  if (second !== first) at = guess - second * 60_000;
  return new Date(at);
}

function parse(value: string, tz: string, edge: "start" | "end") {
  if (DATE.test(value)) {
    const start = localMidnight(value, tz);
    if (Number.isNaN(start.getTime())) return start;
    if (edge === "start") return start;
    // The end of that day: the next day's midnight, less a millisecond.
    const [y, m, d] = value.split("-").map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    return new Date(localMidnight(next, tz).getTime() - 1);
  }
  return new Date(value);
}

export function chatWindow(q: { from?: string; to?: string }, tz: string, now = new Date()) {
  const to = q.to ? parse(q.to, tz, "end") : now;
  const from = q.from ? parse(q.from, tz, "start") : new Date(to.getTime() - DEFAULT_CHAT_DAYS * 86400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new ActionError("from and to are ISO 8601 times, like 2026-03-01T09:00:00-07:00, or dates, like 2026-03-01.");
  if (from > to) throw new ActionError("from is after to. Swap them.");
  return { from, to };
}
