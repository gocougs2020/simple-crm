/**
 * How duplicate records are found and combined. Pure, so the cleanup script
 * (scripts/dedupe.ts), the Pipedrive import and tests share the same rules.
 * See docs/DEDUPE.md.
 *
 * - Organizations are duplicates when their whole names match, ignoring
 *   capitals ("acme" and "Acme", but not "Acme" and "Acme Inc").
 * - People are duplicates when they share an email address (any case) or a
 *   phone number (the last 10 digits, however it was typed), directly or
 *   through each other: A shares an email with B and B a phone with C makes
 *   one group of three.
 * - In each group the oldest record that has anything on it (people,
 *   notes, clients…) is kept. Its own details stay; blanks are filled from
 *   the others: those with notes and activity first, newest first.
 */
import type { CustomValues } from "@/db/schema";
import { matchKey } from "@/lib/phone/numbers";

type Base = { id: string; createdAt: Date };

/** What email addresses are compared on. */
export const emailKey = (e: string | null | undefined) => e?.trim().toLowerCase() ?? "";

/** What phone numbers are compared on: the last 10 digits, or nothing for numbers too short to be one. */
export const phoneKey = (p: string | null | undefined) => {
  const k = matchKey(p);
  return k.length >= 7 ? k : "";
};

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);

const byAge = <T extends Base>(a: T, b: T) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

/** What organization names are compared on: the whole name, without capitals or spaces at either end. */
export const nameKey = (name: string) => name.trim().toLowerCase();

/** Organizations whose whole names match, ignoring capitals. Only groups of two or more, oldest first. */
export function groupByName<T extends Base & { name: string }>(rows: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const key = nameKey(r.name);
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort(byAge));
}

/** Every email and phone a person has, primary first. */
export const contactKeys = (p: { email?: string | null; phone?: string | null; otherEmails?: string[] | null; otherPhones?: string[] | null }) => [
  ...[p.email, ...(p.otherEmails ?? [])].map(emailKey).filter(Boolean).map((k) => `e:${k}`),
  ...[p.phone, ...(p.otherPhones ?? [])].map(phoneKey).filter(Boolean).map((k) => `p:${k}`),
];

/** Records that share any key, directly or through each other (union–find). Only groups of two or more, oldest first. */
export function groupByShared<T extends Base>(rows: T[], keys: (r: T) => string[]): T[][] {
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map<string, number>();
  rows.forEach((r, i) => {
    for (const k of keys(r)) {
      const j = owner.get(k);
      if (j === undefined) owner.set(k, i);
      else parent[find(i)] = find(j);
    }
  });
  const groups = new Map<number, T[]>();
  rows.forEach((r, i) => {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(r);
    else groups.set(root, [r]);
  });
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort(byAge));
}

/**
 * Which record of a group is kept: the oldest with anything on it, or the
 * oldest when none has. The rest are merged into it, or deleted when there's
 * nothing on them.
 *
 * `donors` is the order the others fill the kept record's blanks in: records
 * with something on them before empty ones, and the newest first within
 * each, so a website comes from the newer, active duplicate rather than an
 * empty one.
 */
export function pickSurvivor<T extends Base>(group: T[], hasData: (r: T) => boolean) {
  const sorted = [...group].sort(byAge);
  const survivor = sorted.find(hasData) ?? sorted[0];
  const rest = sorted.filter((r) => r !== survivor);
  const merged = rest.filter(hasData);
  const empty = rest.filter((r) => !hasData(r));
  const newestFirst = (list: T[]) => [...list].reverse();
  return { survivor, merged, empty, donors: [...newestFirst(merged), ...newestFirst(empty)] };
}

/** The fields `target` has blank, filled from the first source that has them (pass sources in priority order). Only changed fields are returned. */
export function fillGaps<T extends Record<string, unknown>, K extends keyof T>(target: T, sources: Partial<T>[], fields: readonly K[]): Partial<Pick<T, K>> {
  const patch: Partial<Pick<T, K>> = {};
  for (const f of fields) {
    if (!isBlank(target[f])) continue;
    const from = sources.find((s) => !isBlank(s[f]));
    if (from) patch[f] = from[f] as T[K];
  }
  return patch;
}

/** Custom field values: the target's, plus any field it has no value for. Null when nothing changes. */
export function mergeCustom(target: CustomValues, sources: (CustomValues | undefined)[]): CustomValues | null {
  const out = { ...target };
  let changed = false;
  for (const s of sources) {
    for (const [k, v] of Object.entries(s ?? {})) {
      if (isBlank(out[k]) && !isBlank(v)) {
        out[k] = v;
        changed = true;
      }
    }
  }
  return changed ? out : null;
}

/** Distinct values, first spelling kept, in order. Values with no key (a phone too short to compare) are compared as typed. */
export function distinct(values: (string | null | undefined)[], key: (v: string) => string) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = raw?.trim();
    if (!v) continue;
    const k = key(v) || v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

const earliest = (dates: (Date | null | undefined)[]) => dates.filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
const latest = (dates: (Date | null | undefined)[]) => dates.filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
const sameTime = (a: Date | null | undefined, b: Date | null | undefined) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

// ─── Organizations ───────────────────────────────────────────────────────

export type OrgFields = {
  id: string;
  createdAt: Date;
  name: string;
  domain: string | null;
  phone: string | null;
  address: string | null;
  industry: string | null;
  ownerId: string | null;
  custom: CustomValues;
  lastActivityAt: Date | null;
  archivedAt: Date | null;
};

/** What changes on the organization that's kept. Archived only when every one of them was. */
export function planOrganizationMerge(survivor: OrgFields, others: Partial<OrgFields>[]) {
  const patch: Partial<OrgFields> = fillGaps(survivor, others, ["domain", "phone", "address", "industry", "ownerId"] as const);
  const custom = mergeCustom(survivor.custom, others.map((o) => o.custom));
  if (custom) patch.custom = custom;
  const last = latest([survivor.lastActivityAt, ...others.map((o) => o.lastActivityAt)]);
  if (!sameTime(last, survivor.lastActivityAt)) patch.lastActivityAt = last;
  if (survivor.archivedAt && others.some((o) => o.id && !o.archivedAt)) patch.archivedAt = null;
  return patch;
}

// ─── People ──────────────────────────────────────────────────────────────

export type PersonFields = {
  id: string;
  createdAt: Date;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  otherEmails: string[];
  otherPhones: string[];
  title: string | null;
  organizationId: string | null;
  ownerId: string | null;
  tags: string[];
  custom: CustomValues;
  marketingOptIn: boolean;
  unsubscribedAt: Date | null;
  emailBouncedAt: Date | null;
  lastCampaignAt: Date | null;
  decisionMaker: boolean;
  textConsentAt: Date | null;
  textOptOutAt: Date | null;
  lastActivityAt: Date | null;
  archivedAt: Date | null;
};

/**
 * What changes on the person who's kept, and which organizations they're
 * also at. Every email and phone of the group is kept: the survivor's (or
 * the oldest one's) as the main one, the rest as other emails and phones.
 * Opt-outs win: if any of them unsubscribed or replied STOP, so does the
 * merged person.
 *
 * `others` can be partial (the Pipedrive import passes just the fields it
 * read), so missing fields are left alone.
 */
export function planPersonMerge(survivor: PersonFields, others: Partial<PersonFields>[], organizations: { survivor: string[]; others: string[] } = { survivor: [], others: [] }) {
  const all = [survivor, ...others];
  const patch: Partial<PersonFields> = fillGaps(survivor, others, ["lastName", "title", "ownerId", "textConsentAt"] as const);

  const emails = distinct(
    all.flatMap((r) => [r.email, ...(r.otherEmails ?? [])]),
    emailKey,
  );
  const email = survivor.email?.trim() || emails[0] || null;
  if (email !== survivor.email) {
    patch.email = email;
    // The bounce goes with the address it was for.
    patch.emailBouncedAt = others.find((o) => emailKey(o.email) === emailKey(email))?.emailBouncedAt ?? null;
  }
  // Stored lowercased, as the import and the person form do, so lookups compare like for like.
  const otherEmails = emails.filter((e) => emailKey(e) !== emailKey(email)).map(emailKey);
  if (JSON.stringify(otherEmails) !== JSON.stringify(survivor.otherEmails)) patch.otherEmails = otherEmails;

  const phoneId = (p: string) => phoneKey(p) || p.trim().toLowerCase();
  const phones = distinct(
    all.flatMap((r) => [r.phone, ...(r.otherPhones ?? [])]),
    phoneKey,
  );
  const phone = survivor.phone?.trim() || phones[0] || null;
  if (phone !== survivor.phone) patch.phone = phone;
  const otherPhones = phones.filter((p) => !phone || phoneId(p) !== phoneId(phone));
  if (JSON.stringify(otherPhones) !== JSON.stringify(survivor.otherPhones)) patch.otherPhones = otherPhones;

  const organizationId = survivor.organizationId ?? others.find((o) => o.organizationId)?.organizationId ?? null;
  if (organizationId !== survivor.organizationId) patch.organizationId = organizationId;
  const alsoAt = [...new Set([...organizations.survivor, ...others.map((o) => o.organizationId), ...organizations.others].filter((o): o is string => !!o && o !== organizationId))];

  const tags = [...new Set([...survivor.tags, ...others.flatMap((o) => o.tags ?? [])])];
  if (tags.length !== survivor.tags.length) patch.tags = tags;
  const custom = mergeCustom(survivor.custom, others.map((o) => o.custom));
  if (custom) patch.custom = custom;

  if (survivor.marketingOptIn && others.some((o) => o.marketingOptIn === false)) patch.marketingOptIn = false;
  for (const [field, pick] of [
    ["unsubscribedAt", earliest],
    ["textOptOutAt", earliest],
    ["lastCampaignAt", latest],
    ["lastActivityAt", latest],
  ] as const) {
    const v = pick(all.map((r) => r[field]));
    if (!sameTime(v, survivor[field])) patch[field] = v;
  }
  if (!survivor.decisionMaker && others.some((o) => o.decisionMaker)) patch.decisionMaker = true;
  if (survivor.archivedAt && others.some((o) => o.id && !o.archivedAt)) patch.archivedAt = null;
  return { patch, alsoAt };
}

/**
 * A Pipedrive import updating a person: Pipedrive's primary email and phone
 * become the main ones, but the ones they replace are kept as other emails
 * and phones (a merge may have put them there), and a blank in Pipedrive
 * never clears one.
 */
export function keepContactsOnImport(current: Pick<PersonFields, "email" | "phone" | "otherEmails" | "otherPhones">, incoming: { email: string | null; phone: string | null }) {
  const email = incoming.email || current.email;
  const phone = incoming.phone || current.phone;
  const phoneId = (p: string) => phoneKey(p) || p.trim().toLowerCase();
  return {
    email,
    phone,
    otherEmails: distinct([current.email, ...current.otherEmails], emailKey)
      .filter((e) => emailKey(e) !== emailKey(email))
      .map(emailKey),
    otherPhones: distinct([current.phone, ...current.otherPhones], phoneKey).filter((p) => !phone || phoneId(p) !== phoneId(phone)),
  };
}
