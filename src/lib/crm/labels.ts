import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { CampaignAudience } from "@/db/schema";

/**
 * Labels: the strings in a record's `tags` (people, organizations and
 * clients), with a definition each in `labels` (description, hidden or
 * shown). An organization's labels carry to its people: wherever people are
 * picked by label (the People list, campaign audiences, the API), someone
 * matches when they or their organization has it (`effectiveTags`).
 */

const { labels, people, organizations, clients } = schema;

export type Label = { id: string | null; name: string; description: string | null; hidden: boolean };

/** Every label with a definition, by name. Loaded with the app-wide data, so chips and pickers know descriptions without a round trip. */
export async function listLabels(): Promise<Label[]> {
  const db = await getDb();
  return db.select({ id: labels.id, name: labels.name, description: labels.description, hidden: labels.hidden }).from(labels).orderBy(asc(labels.name));
}

/** Gives a definition to labels that don't have one yet, so anything put on a record (the API, an import, the agent) shows up in pickers and in Settings. */
export async function ensureLabels(names: readonly string[] | null | undefined) {
  const list = [...new Set((names ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean))];
  if (!list.length) return;
  const db = await getDb();
  await db
    .insert(labels)
    .values(list.map((name) => ({ name })))
    .onConflictDoNothing();
}

/** A person's own labels plus their organization's, as one JSON array to filter on. */
export const effectiveTags = sql`(${people.tags} || coalesce((select o.tags from organizations o where o.id = ${people.organizationId}), '[]'::jsonb))`;

const rowsOf = <T>(r: unknown) => ((r as { rows?: T[] }).rows ?? (r as T[]));

/** How many people, organizations and clients carry each label, including labels with no definition yet. */
export async function labelUsage() {
  const db = await getDb();
  const rows = rowsOf<{ name: string; people: number; organizations: number; clients: number }>(
    await db.execute(sql`
      select name, sum(p)::int as people, sum(o)::int as organizations, sum(c)::int as clients from (
        select jsonb_array_elements_text(tags) as name, 1 as p, 0 as o, 0 as c from people where archived_at is null
        union all select jsonb_array_elements_text(tags), 0, 1, 0 from organizations where archived_at is null
        union all select jsonb_array_elements_text(tags), 0, 0, 1 from clients where archived_at is null
      ) x group by name`),
  );
  return Object.fromEntries(rows.map((r) => [r.name, { people: Number(r.people), organizations: Number(r.organizations), clients: Number(r.clients) }]));
}

const audienceKeys = ["tags", "excludeTags", "clientTags"] as const;

/** Saved audiences and campaigns that haven't gone out whose filters name this label, by name. */
export async function labelAudiences(name: string) {
  const db = await getDb();
  const uses = (a: CampaignAudience) => audienceKeys.some((k) => a[k]?.includes(name));
  const audiences = (await db.select({ name: schema.audiences.name, filters: schema.audiences.filters }).from(schema.audiences)).filter((a) => uses(a.filters)).map((a) => a.name);
  const campaigns = (await db.select({ name: schema.campaigns.name, audience: schema.campaigns.audience, status: schema.campaigns.status }).from(schema.campaigns))
    .filter((c) => c.status !== "sent" && uses(c.audience))
    .map((c) => c.name);
  return { audiences, campaigns };
}

/**
 * Renames a label everywhere it's used (`to` given): records, saved
 * audiences and campaigns' filters. With `to` null it comes off the records
 * only. A filter is never emptied here, because an audience that loses its
 * only label would quietly become everyone: deleting a label that a filter
 * still names is refused first (deleteLabel in src/actions/settings.ts).
 */
export async function rewriteLabel(from: string, to: string | null) {
  const db = await getDb();
  for (const table of [people, organizations, clients]) {
    await db
      .update(table)
      .set({
        tags: to
          ? sql`(select coalesce(jsonb_agg(distinct case when x = ${from} then ${to} else x end), '[]'::jsonb) from jsonb_array_elements_text(${table.tags}) x)`
          : sql`${table.tags} - ${from}::text`,
      })
      .where(sql`${table.tags} ? ${from}`);
  }
  if (!to) return;
  const swap = (a: CampaignAudience) => {
    let changed = false;
    const next = { ...a };
    for (const key of audienceKeys) {
      const list = a[key];
      if (!list?.includes(from)) continue;
      changed = true;
      next[key] = [...new Set(list.map((t) => (t === from ? to : t)))];
    }
    return changed ? next : null;
  };
  for (const a of await db.select({ id: schema.audiences.id, filters: schema.audiences.filters }).from(schema.audiences)) {
    const next = swap(a.filters);
    if (next) await db.update(schema.audiences).set({ filters: next }).where(eq(schema.audiences.id, a.id));
  }
  // Sent campaigns keep the audience they went to, as a record. One that's sending keeps going with the new name.
  for (const c of await db.select({ id: schema.campaigns.id, audience: schema.campaigns.audience, status: schema.campaigns.status }).from(schema.campaigns)) {
    if (c.status === "sent") continue;
    const next = swap(c.audience);
    if (next) await db.update(schema.campaigns).set({ audience: next }).where(eq(schema.campaigns.id, c.id));
  }
}
