/**
 * Formatting shared by server and client components. Dates are always
 * formatted in the workspace's time zone (passed in), so the server and the
 * browser render the same text and everyone on the team sees the same day.
 */

const moneyFormats = new Map<string, Intl.NumberFormat>();

/** `cents` in minor units. Whole amounts drop the decimals: $12,000 rather than $12,000.00. */
export function formatMoney(cents: number, currency = "USD", opts: { compact?: boolean } = {}) {
  const whole = cents % 100 === 0;
  const key = `${currency}:${whole}:${opts.compact}`;
  let f = moneyFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      notation: opts.compact ? "compact" : "standard",
      maximumFractionDigits: opts.compact ? 1 : whole ? 0 : 2,
      minimumFractionDigits: opts.compact || whole ? 0 : 2,
    });
    moneyFormats.set(key, f);
  }
  return f.format(cents / 100);
}

/** Parses "12,500", "$12.5k" or "1.2m" into cents. Null when it isn't a number. */
export function parseMoney(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/[$,\s]/g, "");
  if (!s) return 0;
  const m = /^(-?\d*\.?\d+)([km])?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export const formatNumber = (n: number) => new Intl.NumberFormat("en-US").format(n);

export function personName(p: { firstName: string; lastName?: string | null }) {
  return [p.firstName, p.lastName].filter(Boolean).join(" ");
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

type DateInput = Date | string | number;
const toDate = (d: DateInput) => (d instanceof Date ? d : new Date(d));

function parts(d: DateInput, tz: string) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(toDate(d));
  const get = (t: string) => p.find((x) => x.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The calendar day ("2026-10-30") a moment falls on in the workspace's time zone. */
export const dayKey = (d: DateInput, tz: string) => parts(d, tz);

function dayDiff(d: DateInput, tz: string, now: Date) {
  const a = Date.parse(parts(d, tz));
  const b = Date.parse(parts(now, tz));
  return Math.round((a - b) / 86400_000);
}

/** "Today", "Tomorrow", "Yesterday", "Mon", "Oct 14" or "Oct 14, 2025". */
export function formatDay(d: DateInput, tz: string, now = new Date()) {
  const diff = dayDiff(d, tz, now);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  const sameYear = parts(d, tz).slice(0, 4) === parts(now, tz).slice(0, 4);
  if (diff > 1 && diff < 7) return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(toDate(d));
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(toDate(d));
}

export function formatTime(d: DateInput, tz: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(toDate(d));
}

/** "Today at 3:15 PM", "Oct 14 at 9:00 AM". */
export function formatDateTime(d: DateInput, tz: string, now = new Date()) {
  return `${formatDay(d, tz, now)} at ${formatTime(d, tz)}`;
}

/** Full date for tooltips: "Thursday, October 30, 2026 at 3:15 PM MDT". */
export function formatFull(d: DateInput, tz: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "full", timeStyle: "short" }).format(toDate(d));
}

/**
 * A date-only value ("2026-11-15", from a date column) as "Nov 15", with no
 * time zone shifting. "Today" and "Yesterday" are judged by the calendar in
 * the workspace's time zone, which is where these dates were picked.
 */
export function formatDateOnly(iso: string, tz: string, now = new Date()) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  return formatDay(date, "UTC", new Date(`${dayKey(now, tz)}T12:00:00Z`));
}

/** "just now", "5m", "3h", "2d", then a date. For the dense "last activity" columns. */
export function formatAgo(d: DateInput, tz: string, now = new Date()) {
  const s = Math.max(0, (now.getTime() - toDate(d).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return formatDay(d, tz, now);
}

/** Whole days between a moment and now (for "in stage 12 days"). */
export function daysSince(d: DateInput, now = new Date()) {
  return Math.floor((now.getTime() - toDate(d).getTime()) / 86400_000);
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Urgency of a task's due date, for its status badge. */
export function dueTone(due: DateInput, tz: string, now = new Date()): "error" | "success" | "warning" | "neutral" {
  const diff = dayDiff(due, tz, now);
  if (diff < 0) return "error";
  if (diff === 0) return "success";
  if (diff === 1) return "warning";
  return "neutral";
}

/** Formats "(208) 555-0134" while typing, for US numbers; anything else is left alone. */
export function formatPhoneInput(v: string) {
  if (/^\+(?!1)/.test(v.trim())) return v;
  const d = v.replace(/\D/g, "").replace(/^1(?=\d{10})/, "").slice(0, 10);
  if (d.length < 4) return d;
  if (d.length < 7) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/**
 * The UTC instant of a wall-clock time on a calendar day in a time zone,
 * e.g. ("2026-11-03", "09:30", "America/Denver"). Handles daylight saving.
 */
export function zonedTime(ymd: string, hhmm: string, tz: string) {
  const guess = new Date(`${ymd}T${hhmm}:00Z`);
  const offsetAt = (d: Date) => {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d);
    const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - d.getTime();
  };
  const first = new Date(guess.getTime() - offsetAt(guess));
  return new Date(guess.getTime() - offsetAt(first));
}

/** Today's calendar day in a time zone, plus `days`. */
export function dayFromToday(tz: string, days = 0, now = new Date()) {
  const ymd = dayKey(now, tz);
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "HH:MM" of a moment in a time zone, for time inputs. */
export function timeKey(d: DateInput, tz: string) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(toDate(d));
}

/** "Sam Lee <sam@acme.com>" → "Sam Lee"; a bare address stays as it is. */
export const senderName = (raw: string) => /^\s*"?([^"<]+?)"?\s*</.exec(raw)?.[1]?.trim() || (/<([^>]+)>/.exec(raw)?.[1] ?? raw);
