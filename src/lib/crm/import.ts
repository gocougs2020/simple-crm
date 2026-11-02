import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { textToHtml } from "@/lib/safe-html";
import type { ImportChunkResult, ImportDefaults, ImportRow } from "./import-fields";

type Person = typeof schema.people.$inferSelect;
/** Fields an import may write, and so the ones undo restores. */
type Patch = Partial<Pick<Person, "firstName" | "lastName" | "email" | "phone" | "title" | "organizationId" | "tags" | "marketingOptIn">>;
const textFields = ["firstName", "lastName", "phone", "title"] as const;
const maxLength = { firstName: 80, lastName: 80, phone: 40, title: 120 } as const;
const emailSchema = z.email();

/**
 * Applies one batch of rows. Rows match existing people by email; a match
 * only gains what the row adds (blank cells never erase anything, tags merge,
 * notes become a note on their timeline). Organizations match by name and are
 * created when new. Everything is recorded on the import so it can be undone.
 */
export async function importRows(importId: string, rows: ImportRow[], defaults: ImportDefaults, userId: string): Promise<ImportChunkResult> {
  const db = await getDb();
  const [imp] = await db.select().from(schema.peopleImports).where(eq(schema.peopleImports.id, importId));
  if (!imp) throw new Error("Import not found");
  if (imp.undoneAt) throw new Error("This import was undone.");
  const ownIds = new Set(imp.createdIds);
  const result: ImportChunkResult = { created: 0, updated: 0, unchanged: 0, organizations: 0, skipped: [] };

  const clean: ImportRow[] = [];
  for (const r of rows) {
    const email = r.email?.trim().toLowerCase();
    if (email && !emailSchema.safeParse(email).success) {
      result.skipped.push({ row: r.row, reason: `“${r.email}” isn't a valid email` });
      continue;
    }
    if (!email && !r.firstName?.trim()) {
      result.skipped.push({ row: r.row, reason: "No name or email" });
      continue;
    }
    // With only an email, use the part before @ as a first name so the person is findable.
    clean.push({ ...r, email: email || undefined, firstName: r.firstName?.trim() || email!.split("@")[0] });
  }

  // Organizations by name (case-insensitive), creating the missing ones.
  const orgNames = [...new Set(clean.map((r) => r.organization?.trim()).filter((n): n is string => !!n))];
  const orgIds = new Map<string, string>();
  if (orgNames.length) {
    const found = await db
      .select({ id: schema.organizations.id, name: schema.organizations.name })
      .from(schema.organizations)
      .where(and(isNull(schema.organizations.archivedAt), inArray(sql`lower(${schema.organizations.name})`, orgNames.map((n) => n.toLowerCase()))));
    for (const o of found) orgIds.set(o.name.toLowerCase(), o.id);
    const missing = orgNames.filter((n) => !orgIds.has(n.toLowerCase()));
    if (missing.length) {
      const created = await db
        .insert(schema.organizations)
        .values(missing.map((name) => ({ name: name.slice(0, 120), ownerId: defaults.ownerId, createdBy: userId })))
        .returning({ id: schema.organizations.id, name: schema.organizations.name });
      for (const o of created) orgIds.set(o.name.toLowerCase(), o.id);
      result.organizations = created.length;
      await db
        .update(schema.peopleImports)
        .set({ createdOrgIds: sql`${schema.peopleImports.createdOrgIds} || ${JSON.stringify(created.map((o) => o.id))}::jsonb` })
        .where(eq(schema.peopleImports.id, importId));
    }
  }

  const emails = [...new Set(clean.map((r) => r.email).filter((e): e is string => !!e))];
  const existing = new Map<string, Person>();
  if (emails.length) for (const p of await db.select().from(schema.people).where(and(inArray(schema.people.email, emails), isNull(schema.people.archivedAt)))) existing.set(p.email!, p);

  const inserts: (Patch & { firstName: string; notes?: string })[] = [];
  const pendingByEmail = new Map<string, Patch & { firstName: string; notes?: string }>();
  const patches = new Map<string, { person: Person; patch: Patch; notes: string[] }>();

  for (const r of clean) {
    const organizationId = r.organization ? (orgIds.get(r.organization.trim().toLowerCase()) ?? null) : undefined;
    const found = r.email ? existing.get(r.email) : undefined;
    if (found) {
      const entry = patches.get(found.id) ?? { person: found, patch: {}, notes: [] };
      merge(entry.patch, { ...found, ...entry.patch }, r, organizationId);
      if (r.notes?.trim()) entry.notes.push(r.notes.trim());
      patches.set(found.id, entry);
      continue;
    }
    const pending = r.email ? pendingByEmail.get(r.email) : undefined;
    if (pending) {
      merge(pending, pending, r, organizationId);
      if (r.notes?.trim()) pending.notes = [pending.notes, r.notes.trim()].filter(Boolean).join("\n\n");
      continue;
    }
    const values: Patch & { firstName: string; notes?: string } = { firstName: "", email: r.email ?? null, tags: [], marketingOptIn: defaults.marketingOptIn, organizationId: null };
    merge(values, values, r, organizationId);
    values.notes = r.notes?.trim() || undefined;
    inserts.push(values);
    if (r.email) pendingByEmail.set(r.email, values);
  }

  const created = inserts.length
    ? await db
        .insert(schema.people)
        .values(inserts.map((v) => ({ firstName: v.firstName, lastName: v.lastName, email: v.email, phone: v.phone, title: v.title, organizationId: v.organizationId, tags: v.tags, marketingOptIn: v.marketingOptIn, ownerId: defaults.ownerId, createdBy: userId })))
        .returning({ id: schema.people.id })
    : [];
  result.created = created.length;
  const noteRows = created.flatMap((p, i) => (inserts[i].notes ? [{ type: "note" as const, body: textToHtml(inserts[i].notes!), personId: p.id, organizationId: inserts[i].organizationId ?? null, userId, occurredAt: new Date() }] : []));

  const changed = [...patches.values()].filter(({ patch, notes }) => Object.keys(patch).length || notes.length);
  result.unchanged = patches.size - changed.length;
  result.updated = changed.length;
  for (let i = 0; i < changed.length; i += 25) {
    await Promise.all(changed.slice(i, i + 25).filter(({ patch }) => Object.keys(patch).length).map(({ person, patch }) => db.update(schema.people).set({ ...patch, updatedAt: new Date() }).where(eq(schema.people.id, person.id))));
  }
  const updates: { id: string; before: Record<string, unknown> }[] = [];
  const existingNotes = changed.flatMap(({ person, notes }) => notes.map((n) => ({ type: "note" as const, body: textToHtml(n), personId: person.id, organizationId: person.organizationId, userId, occurredAt: new Date() })));
  for (const { person, patch } of changed) {
    // A person this import created needs no snapshot: undo deletes them.
    if (ownIds.has(person.id) || !Object.keys(patch).length) continue;
    updates.push({ id: person.id, before: Object.fromEntries(Object.keys(patch).map((k) => [k, person[k as keyof Patch]])) });
  }
  if (noteRows.length) await db.insert(schema.activities).values(noteRows);
  const addedNotes = existingNotes.length ? await db.insert(schema.activities).values(existingNotes).returning({ id: schema.activities.id }) : [];

  const t = schema.peopleImports;
  await db
    .update(t)
    .set({
      createdIds: sql`${t.createdIds} || ${JSON.stringify(created.map((r) => r.id))}::jsonb`,
      createdActivityIds: sql`${t.createdActivityIds} || ${JSON.stringify(addedNotes.map((r) => r.id))}::jsonb`,
      updates: sql`${t.updates} || ${JSON.stringify(updates)}::jsonb`,
      created: sql`${t.created} + ${result.created}`,
      updated: sql`${t.updated} + ${result.updated}`,
      unchanged: sql`${t.unchanged} + ${result.unchanged}`,
      skipped: sql`${t.skipped} + ${result.skipped.length}`,
    })
    .where(eq(t.id, importId));
  return result;
}

/** Adds what `r` brings to `patch`, compared against `current` (the person as they'll be with the patch applied). */
function merge(patch: Patch, current: Patch, r: ImportRow, organizationId: string | null | undefined) {
  for (const k of textFields) {
    const v = r[k]?.trim().slice(0, maxLength[k]);
    if (v && v !== current[k]) (patch as Record<string, unknown>)[k] = v;
  }
  if (organizationId && organizationId !== current.organizationId) patch.organizationId = organizationId;
  if (r.marketingOptIn !== undefined && r.marketingOptIn !== current.marketingOptIn) patch.marketingOptIn = r.marketingOptIn;
  if (r.tags?.length) {
    const tags = [...new Set([...(current.tags ?? []), ...r.tags])].slice(0, 30);
    if (tags.length !== (current.tags ?? []).length) patch.tags = tags;
  }
}

/** Removes the people and organizations an import added, deletes notes it added, and puts back what it changed. */
export async function undoImport(importId: string) {
  const db = await getDb();
  const t = schema.peopleImports;
  // Claim it first, so a double click can't undo twice.
  const [imp] = await db
    .update(t)
    .set({ undoneAt: new Date() })
    .where(and(eq(t.id, importId), isNull(t.undoneAt)))
    .returning();
  if (!imp) throw new Error("This import was already undone.");
  const restores = new Map<string, Record<string, unknown>>();
  for (const u of [...imp.updates].reverse()) restores.set(u.id, { ...restores.get(u.id), ...u.before });
  for (const [id, before] of restores) await db.update(schema.people).set(before as Patch).where(eq(schema.people.id, id));
  for (let i = 0; i < imp.createdActivityIds.length; i += 500) await db.delete(schema.activities).where(inArray(schema.activities.id, imp.createdActivityIds.slice(i, i + 500)));
  for (let i = 0; i < imp.createdIds.length; i += 500) await db.delete(schema.people).where(inArray(schema.people.id, imp.createdIds.slice(i, i + 500)));
  // Only organizations nothing else has started using since.
  for (const id of imp.createdOrgIds) {
    const [inUse] = await db.select({ id: schema.people.id }).from(schema.people).where(eq(schema.people.organizationId, id)).limit(1);
    const [hasClient] = await db.select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.organizationId, id)).limit(1);
    if (!inUse && !hasClient) await db.delete(schema.organizations).where(eq(schema.organizations.id, id));
  }
  return { removed: imp.createdIds.length, restored: restores.size };
}
