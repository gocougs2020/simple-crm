/**
 * Helpers for `pnpm import:pipedrive --new-only --since=…`
 * (scripts/import-pipedrive.ts): reading the window, following merges, and
 * finding the record a Pipedrive person or organization already is here.
 * Pure, so they're tested on their own. See docs/PIPEDRIVE-IMPORT.md.
 */
import { emailKey, nameKey, personMatchKeys } from "./merge";

const DAY = 24 * 60 * 60 * 1000;

/** `--since=14` or `--since=14d` (days back from now) or `--since=2026-11-08` → the start of the window. Undefined when not given. */
export function parseSince(value: string | undefined, now = new Date()): Date | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  const days = /^(\d+)d?$/i.exec(v);
  if (days && Number(days[1]) > 0) return new Date(now.getTime() - Number(days[1]) * DAY);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(`${v}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  throw new Error(`--since takes a number of days (--since=14) or a date (--since=2026-11-08), not "${value}".`);
}

/** A "merged" history entry: the kept record's id, with the records merged into it in `data.merged` and `data.deleted`. */
export type MergeEvent = { entityId: string; data: Record<string, unknown> };

/** Each merged-away record's id → the id of the record it was merged into. */
export function mergedInto(events: MergeEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of events) {
    for (const list of [e.data.merged, e.data.deleted]) {
      if (!Array.isArray(list)) continue;
      for (const r of list) {
        const id = r && typeof r === "object" ? (r as { id?: unknown }).id : null;
        if (typeof id === "string" && id !== e.entityId) out.set(id, e.entityId);
      }
    }
  }
  return out;
}

/** The record an id stands for now: itself while it exists, otherwise the one it was merged into (and so on, for merges of merges). Null when it's gone. */
export function followMerges(id: string | null | undefined, exists: (id: string) => boolean, into: Map<string, string>): string | null {
  const seen = new Set<string>();
  for (let cur = id ?? undefined; cur && !seen.has(cur); cur = into.get(cur)) {
    if (exists(cur)) return cur;
    seen.add(cur);
  }
  return null;
}

export type MatchPerson = { id: string; firstName: string; lastName: string | null; email: string | null; phone: string | null; otherEmails?: string[] | null; otherPhones?: string[] | null };
export type IncomingPerson = Omit<MatchPerson, "id">;

/**
 * Finds the person someone from Pipedrive already is here. The same name with
 * a shared email or phone (what `pnpm run dedupe` merges on) matches; failing
 * that, an email address that only one person here has. A phone alone or a
 * name alone doesn't: offices share lines and people share names.
 */
export class PersonMatcher {
  private byKey = new Map<string, string>();
  private byEmail = new Map<string, Set<string>>();
  /** Add people in the order they should win a tie: the first one added for a key is the match. */
  constructor(people: MatchPerson[] = []) {
    for (const p of people) this.add(p);
  }
  add(p: MatchPerson) {
    for (const k of personMatchKeys(p)) if (!this.byKey.has(k)) this.byKey.set(k, p.id);
    for (const e of [p.email, ...(p.otherEmails ?? [])].map(emailKey).filter(Boolean)) this.byEmail.set(e, new Set([...(this.byEmail.get(e) ?? []), p.id]));
  }
  find(p: IncomingPerson): string | null {
    for (const k of personMatchKeys(p)) {
      const id = this.byKey.get(k);
      if (id) return id;
    }
    for (const e of [p.email, ...(p.otherEmails ?? [])].map(emailKey).filter(Boolean)) {
      const ids = this.byEmail.get(e);
      if (ids?.size === 1) return [...ids][0];
    }
    return null;
  }
}

/** Finds the organization one from Pipedrive already is here: the same whole name, ignoring capitals (what `pnpm run dedupe` merges on). */
export class OrganizationMatcher {
  private byName = new Map<string, string>();
  /** Add organizations in the order they should win a tie. */
  constructor(orgs: { id: string; name: string }[] = []) {
    for (const o of orgs) this.add(o);
  }
  add(o: { id: string; name: string }) {
    const k = nameKey(o.name);
    if (k && !this.byName.has(k)) this.byName.set(k, o.id);
  }
  find(name: string | null | undefined) {
    return name ? (this.byName.get(nameKey(name)) ?? null) : null;
  }
}

/** Whether a Pipedrive time falls in the window (always, without one). Unknown times count as outside it. */
export const inWindow = (at: Date | null | undefined, since: Date | undefined) => !since || (!!at && at.getTime() >= since.getTime());
