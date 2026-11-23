import "server-only";
import { and, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import type { EntityType } from "@/lib/constants";
import { actorUserId, assertCan, stamp, type Actor } from "@/lib/crm/actor";
import { cleanCustomValues } from "@/lib/crm/custom-fields";
import { appConfig } from "@/app.config";
import { diff, eventRow, labelRelations, recordEvent, recordEvents } from "@/lib/crm/events";
import { writeBatch } from "@/db/batch";
import { withCustomChanges } from "@/lib/crm/inputs";
import { ensureLabels } from "@/lib/crm/labels";
import { distinct, emailKey, phoneKey } from "@/lib/crm/merge";
import { id, orgInput, personInput, tagList } from "@/lib/crm/schemas";
import { ActionError, ConflictError, NotFoundError } from "@/lib/errors";
import { recordAssigned } from "@/lib/push/triggers";
import { matchKey } from "@/lib/phone/numbers";
import { adoptThreadsForPhones } from "@/lib/twilio/threads";

type Person = typeof schema.people.$inferSelect;

/**
 * Creating, changing and archiving people and organizations. Shared by the
 * server actions (the browser), the REST API and MCP: each takes the actor
 * making the change, checks its permission, and writes history in the same
 * step. Callers in the browser refresh the page afterwards.
 */

const { people, organizations, clients } = schema;

/** Fields whose changes show up in a record's history, with the words the timeline uses. */
const personLabels = {
  firstName: "First name",
  lastName: "Last name",
  email: "Email",
  phone: "Phone",
  otherEmails: "Other emails",
  otherPhones: "Other phones",
  title: "Job title",
  organizationId: "Organization",
  ownerId: "Owner",
  tags: "Labels",
  marketingOptIn: "Email opt-in",
  decisionMaker: appConfig.records.keyContactLabel,
  textConsent: "Agreed to marketing texts",
} as const;

/** `textConsent` is a yes/no in the API; the record keeps when it was given. */
function consentColumns(textConsent: boolean | undefined, before?: Date | null) {
  if (textConsent === undefined) return {};
  return { textConsentAt: textConsent ? (before ?? new Date()) : null };
}
const orgLabels = { name: "Name", domain: "Website", phone: "Phone", address: "Address", industry: "Industry", tags: "Labels", isParent: "Is a parent organization", parentId: "Parent organization", ownerId: "Owner" } as const;

/** A new record's owner: whoever was named, else the teammate creating it (a workspace key leaves it unowned). */
const ownerFor = (a: Actor, ownerId: string | null | undefined) => (ownerId === undefined ? actorUserId(a) : ownerId);

export async function assertUser(userId: string | null | undefined, label: string) {
  if (!userId) return;
  const db = await getDb();
  const [u] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId));
  if (!u) throw new NotFoundError(`That ${label} isn't on the team. Pick someone from GET /users.`);
}

export async function assertOrganization(orgId: string | null | undefined) {
  if (!orgId) return;
  const db = await getDb();
  const [o] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, orgId));
  if (!o) throw new NotFoundError("That organization doesn't exist.");
}

export async function assertPerson(personId: string | null | undefined) {
  if (!personId) return;
  const db = await getDb();
  const [p] = await db.select({ id: people.id }).from(people).where(eq(people.id, personId));
  if (!p) throw new NotFoundError("That person doesn't exist.");
}

// ─── Organizations ───────────────────────────────────────────────────────

/**
 * Parent organizations are one level deep: an organization can be part of
 * one marked as a parent, and a parent isn't part of another. `self` is the
 * organization as it will be; `changed` says which of the two fields the
 * change touches, so an old link to a since-archived parent doesn't block
 * unrelated edits.
 */
async function assertParentRules(self: { id?: string; name: string; isParent: boolean; parentId: string | null }, changed: { isParent: boolean; parentId: boolean }) {
  const db = await getDb();
  if (self.parentId && (changed.parentId || changed.isParent)) {
    if (self.parentId === self.id) throw new ActionError(`${self.name} can't be its own parent organization. Pick a different one.`);
    if (self.isParent) throw new ConflictError(`${self.name} is a parent organization, so it can't be part of another. Remove its parent organization first, or leave it unmarked as a parent.`);
  }
  if (self.parentId && changed.parentId) {
    const [parent] = await db.select({ name: organizations.name, isParent: organizations.isParent, archivedAt: organizations.archivedAt }).from(organizations).where(eq(organizations.id, self.parentId));
    if (!parent) throw new NotFoundError("That parent organization doesn't exist.");
    if (parent.archivedAt) throw new ConflictError(`${parent.name} is archived. Restore it, or pick another parent organization.`);
    if (!parent.isParent) throw new ConflictError(`${parent.name} isn't marked as a parent organization. Mark it as one on its page first, then pick it here.`);
  }
  if (self.id && changed.isParent && !self.isParent) {
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(organizations).where(eq(organizations.parentId, self.id));
    if (row.n) throw new ConflictError(`${row.n} ${row.n === 1 ? "organization is" : "organizations are"} part of ${self.name}. Move ${row.n === 1 ? "it" : "them"} to another parent organization first.`);
  }
}

export async function insertOrganization(a: Actor, input: z.input<typeof orgInput>) {
  const data = orgInput.parse(input);
  await assertUser(data.ownerId, "owner");
  await assertParentRules({ name: data.name, isParent: !!data.isParent, parentId: data.parentId ?? null }, { isParent: true, parentId: true });
  const db = await getDb();
  const [row] = await db
    .insert(organizations)
    .values({ ...data, ownerId: ownerFor(a, data.ownerId), custom: data.custom ? await cleanCustomValues("organization", data.custom) : {}, createdBy: actorUserId(a) })
    .returning({ id: organizations.id, name: organizations.name });
  await ensureLabels(data.tags);
  await recordEvent({ entityType: "organization", entityId: row.id, action: "created", ...stamp(a) });
  recordAssigned(a, { entity: "organization", id: row.id, name: row.name, ownerId: ownerFor(a, data.ownerId) });
  return row;
}

export async function createOrganization(a: Actor, input: z.input<typeof orgInput>) {
  assertCan(a, "records:write");
  const db = await getDb();
  const wanted = String(input.name ?? "").trim();
  const [dupe] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(and(sql`lower(${organizations.name}) = lower(${wanted})`, isNull(organizations.archivedAt)))
    .limit(1);
  if (dupe) throw new ConflictError(`${wanted} already exists. Open it from search instead.`, { cause: { id: dupe.id } });
  return insertOrganization(a, input);
}

export async function updateOrganization(a: Actor, orgId: string, patch: Partial<z.input<typeof orgInput>>) {
  assertCan(a, "records:write");
  const data = orgInput.partial().parse(patch);
  await assertUser(data.ownerId, "owner");
  const db = await getDb();
  const [before] = await db.select().from(organizations).where(eq(organizations.id, id.parse(orgId)));
  if (!before) throw new NotFoundError("This organization was deleted.");
  const isParent = data.isParent ?? before.isParent;
  const parentId = data.parentId !== undefined ? data.parentId : before.parentId;
  await assertParentRules({ id: before.id, name: data.name ?? before.name, isParent, parentId }, { isParent: isParent !== before.isParent, parentId: parentId !== before.parentId });
  const custom = data.custom ? { ...before.custom, ...(await cleanCustomValues("organization", data.custom)) } : undefined;
  // What changed is worked out first (it only reads), so the update and its history entry go together: one round trip, one transaction.
  const [related, customChanges] = await Promise.all([labelRelations(diff(before, { ...data, custom: undefined }, orgLabels)), withCustomChanges("organization", before.custom, custom)]);
  const changes = [...related, ...customChanges];
  await writeBatch((d) => [
    d.update(organizations).set({ ...data, custom, updatedAt: new Date() }).where(eq(organizations.id, before.id)),
    ...(changes.length ? [d.insert(schema.events).values(eventRow({ entityType: "organization", entityId: before.id, action: "updated", data: { changes }, ...stamp(a) }))] : []),
  ]);
  await ensureLabels(data.tags);
  if (data.ownerId !== undefined) recordAssigned(a, { entity: "organization", id: before.id, name: data.name ?? before.name, ownerId: data.ownerId, previousOwnerId: before.ownerId });
  return { id: before.id };
}

// ─── People ──────────────────────────────────────────────────────────────

/** "Add 'Sam Lee' as a new person" from a picker: first word is the first name. */
export async function insertPersonByName(a: Actor, fullName: string, organizationId: string | null) {
  const db = await getDb();
  const [first, ...rest] = fullName.trim().split(/\s+/);
  const [p] = await db
    .insert(people)
    .values({ firstName: first, lastName: rest.join(" ") || null, organizationId, ownerId: actorUserId(a), createdBy: actorUserId(a) })
    .returning({ id: people.id });
  await recordEvent({ entityType: "person", entityId: p.id, action: "created", ...stamp(a) });
  return p;
}

/**
 * Other emails and phones without duplicates or the primary one, whichever
 * changed: making an other address primary takes it off the list. Only the
 * lists that change are returned.
 */
function otherContacts(data: Partial<Pick<Person, "email" | "phone" | "otherEmails" | "otherPhones">>, before: Pick<Person, "email" | "phone" | "otherEmails" | "otherPhones">) {
  const out: Partial<Pick<Person, "otherEmails" | "otherPhones">> = {};
  const email = data.email !== undefined ? data.email : before.email;
  const emails = distinct(data.otherEmails ?? before.otherEmails, emailKey).filter((e) => emailKey(e) !== emailKey(email));
  if (data.otherEmails || JSON.stringify(emails) !== JSON.stringify(before.otherEmails)) out.otherEmails = emails;
  const phone = data.phone !== undefined ? data.phone : before.phone;
  const same = (p: string) => !!phone && (phoneKey(p) ? phoneKey(p) === phoneKey(phone) : p.trim().toLowerCase() === phone.trim().toLowerCase());
  const phones = distinct(data.otherPhones ?? before.otherPhones, phoneKey).filter((p) => !same(p));
  if (data.otherPhones || JSON.stringify(phones) !== JSON.stringify(before.otherPhones)) out.otherPhones = phones;
  return out;
}

export async function createPerson(a: Actor, input: z.input<typeof personInput> & { newOrganizationName?: string }) {
  assertCan(a, "records:write");
  const { textConsent, ...parsed } = personInput.parse(input);
  const data = { ...parsed, ...otherContacts(parsed, { email: null, phone: null, otherEmails: [], otherPhones: [] }) };
  await Promise.all([assertUser(data.ownerId, "owner"), assertOrganization(data.organizationId)]);
  const db = await getDb();
  let organizationId = data.organizationId ?? null;
  // "Add 'Acme' as a new organization" from the picker creates both in one step.
  if (!organizationId && input.newOrganizationName?.trim()) organizationId = (await insertOrganization(a, { name: input.newOrganizationName.trim() })).id;
  if (data.email) {
    const [dupe] = await db.select({ id: people.id }).from(people).where(and(eq(people.email, data.email), isNull(people.archivedAt))).limit(1);
    if (dupe) throw new ConflictError(`Someone with ${data.email} already exists. Open them from search instead.`, { cause: { id: dupe.id } });
  }
  const [row] = await db
    .insert(people)
    .values({ ...data, ...consentColumns(textConsent), organizationId, ownerId: ownerFor(a, data.ownerId), tags: data.tags ?? [], custom: data.custom ? await cleanCustomValues("person", data.custom) : {}, createdBy: actorUserId(a) })
    .returning({ id: people.id });
  await ensureLabels(data.tags);
  await recordEvent({ entityType: "person", entityId: row.id, action: "created", ...stamp(a) });
  recordAssigned(a, { entity: "person", id: row.id, name: [data.firstName, data.lastName].filter(Boolean).join(" ") || "a contact", ownerId: ownerFor(a, data.ownerId) });
  await adoptThreadsForPhones([data.phone, ...(data.otherPhones ?? [])]);
  return row;
}

export async function updatePerson(a: Actor, personId: string, patch: Partial<z.input<typeof personInput>>) {
  assertCan(a, "records:write");
  const { textConsent, ...parsed } = personInput.partial().parse(patch);
  await Promise.all([assertUser(parsed.ownerId, "owner"), assertOrganization(parsed.organizationId)]);
  const db = await getDb();
  const [before] = await db.select().from(people).where(eq(people.id, id.parse(personId)));
  if (!before) throw new NotFoundError("This person was deleted.");
  const data = { ...parsed, ...otherContacts(parsed, before) };
  if (data.email && data.email !== before.email) {
    const [dupe] = await db
      .select({ id: people.id })
      .from(people)
      .where(and(eq(people.email, data.email), isNull(people.archivedAt), ne(people.id, before.id)))
      .limit(1);
    if (dupe) throw new ConflictError(`Someone else already has ${data.email}.`, { cause: { id: dupe.id } });
  }
  const custom = data.custom ? { ...before.custom, ...(await cleanCustomValues("person", data.custom)) } : undefined;
  // A new address gets a fresh start after a bounce.
  const newAddress = data.email !== undefined && (data.email ?? null)?.toLowerCase() !== before.email?.toLowerCase();
  // What changed is worked out first (it only reads), so the update and its history entry go together: one round trip, one transaction.
  const [related, customChanges] = await Promise.all([
    labelRelations(diff({ ...before, textConsent: !!before.textConsentAt }, { ...data, ...(textConsent !== undefined ? { textConsent } : {}), custom: undefined }, personLabels)),
    withCustomChanges("person", before.custom, custom),
  ]);
  const changes = [...related, ...customChanges];
  await writeBatch((d) => [
    d
      .update(people)
      .set({ ...data, ...consentColumns(textConsent, before.textConsentAt), custom, ...(newAddress ? { emailBouncedAt: null } : {}), updatedAt: new Date() })
      .where(eq(people.id, before.id)),
    ...(changes.length ? [d.insert(schema.events).values(eventRow({ entityType: "person", entityId: before.id, action: "updated", data: { changes }, ...stamp(a) }))] : []),
  ]);
  await ensureLabels(data.tags);
  if (data.ownerId !== undefined) recordAssigned(a, { entity: "person", id: before.id, name: [data.firstName ?? before.firstName, data.lastName ?? before.lastName].filter(Boolean).join(" ") || "a contact", ownerId: data.ownerId, previousOwnerId: before.ownerId });
  // New numbers, main or other: conversations with them that nobody had move onto this person.
  const had = new Set([before.phone, ...before.otherPhones].map((p) => matchKey(p)));
  await adoptThreadsForPhones([data.phone, ...(data.otherPhones ?? [])].filter((p) => p && !had.has(matchKey(p))));
  return { id: before.id };
}

// ─── Archive (soft delete) ───────────────────────────────────────────────

const tables = { person: people, organization: organizations, client: clients } as const;

/** The activities a record is the home of: logged on it, not on a client (or person) that rolled up to it (src/lib/crm/activity-archive.ts). */
function homedOn(entity: EntityType, ids: string[]) {
  const { activities } = schema;
  if (entity === "client") return inArray(activities.clientId, ids);
  if (entity === "person") return and(isNull(activities.clientId), inArray(activities.personId, ids));
  return and(isNull(activities.clientId), isNull(activities.personId), inArray(activities.organizationId, ids));
}

/**
 * Archived records disappear from lists and search but keep their history.
 * The activities logged on them (open tasks, planned meetings, notes) are
 * archived with them: they follow the record's `archivedAt`, so they leave
 * the Activities page, counts, reminders and the calendar now and come back
 * when it's restored. `openActivities` is how many open tasks and planned
 * calls or meetings that touched, per record, for history and the toast.
 */
export async function setArchived(a: Actor, entity: EntityType, ids: string[], archived: boolean) {
  assertCan(a, "records:archive");
  const list = z.array(id).min(1).max(500).parse(ids);
  const table = tables[entity];
  const db = await getDb();
  const rows = await db
    .update(table)
    .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
    .where(inArray(table.id, list))
    .returning({ id: table.id });
  const changed = rows.map((r) => r.id);
  const { activities } = schema;
  const home = entity === "client" ? activities.clientId : entity === "person" ? activities.personId : activities.organizationId;
  const open = changed.length
    ? await db
        .select({ id: home, n: sql<number>`count(*)::int` })
        .from(activities)
        .where(and(homedOn(entity, changed), isNull(activities.completedAt), sql`${activities.dueAt} is not null`))
        .groupBy(home)
    : [];
  const openOn = new Map(open.map((o) => [o.id, Number(o.n)]));
  await recordEvents(
    rows.map((r) => {
      const n = openOn.get(r.id) ?? 0;
      return { entityType: entity, entityId: r.id, action: archived ? "archived" : "restored", ...(n ? { data: { openActivities: n } } : {}), ...stamp(a) };
    }),
  );
  return { count: rows.length, ids: changed, openActivities: [...openOn.values()].reduce((s, n) => s + n, 0) };
}

// ─── Labels on many records ──────────────────────────────────────────────

/** Puts labels on the records a condition picks, keeping the ones they have, and writes history for each record that changed. */
async function addLabelsWhere(a: Actor, entity: EntityType, where: SQL, names: string[]) {
  const table = tables[entity];
  const db = await getDb();
  const before = await db.select({ id: table.id, tags: table.tags }).from(table).where(where);
  const changed = before.filter((b) => names.some((n) => !b.tags.includes(n))).map((b) => ({ ...b, next: [...new Set([...b.tags, ...names])] }));
  if (!changed.length) return { count: before.length, changed: 0 };
  const ids = changed.map((b) => b.id);
  // The labels are added in SQL, so a change made to a record's labels since the read above isn't written over.
  await db
    .update(table)
    .set({ tags: sql`(select coalesce(jsonb_agg(x order by ord), '[]'::jsonb) from (select x, min(ord) as ord from jsonb_array_elements_text(${table.tags} || ${JSON.stringify(names)}::jsonb) with ordinality t(x, ord) group by x) u)`, updatedAt: new Date() })
    .where(inArray(table.id, ids));
  await ensureLabels(names);
  await recordEvents(changed.map((b) => ({ entityType: entity, entityId: b.id, action: "updated", data: { changes: [{ field: "tags", label: "Labels", from: b.tags, to: b.next }] }, ...stamp(a) })));
  return { count: before.length, changed: changed.length };
}

const labelNames = tagList.min(1, "Pick a label.").transform((names) => [...new Set(names)]);

/** Adds labels to the selected people, organizations or clients. `count` is how many records were picked; `changed` how many didn't have them all already. */
export async function addLabels(a: Actor, entity: EntityType, ids: string[], labels: string[]) {
  assertCan(a, "records:write");
  const list = z.array(id).min(1).max(500).parse(ids);
  return addLabelsWhere(a, entity, inArray(tables[entity].id, list), labelNames.parse(labels));
}

/** Adds labels to every organization that is part of a parent organization. Archived ones are left alone. */
export async function addLabelsToChildOrganizations(a: Actor, parentId: string, labels: string[]) {
  assertCan(a, "records:write");
  const names = labelNames.parse(labels);
  const db = await getDb();
  const [parent] = await db.select({ id: organizations.id, isParent: organizations.isParent }).from(organizations).where(eq(organizations.id, id.parse(parentId)));
  if (!parent) throw new NotFoundError("This organization was deleted.");
  if (!parent.isParent) throw new ConflictError("This organization isn't a parent organization, so no organizations are part of it.");
  return addLabelsWhere(a, "organization", and(eq(organizations.parentId, parent.id), isNull(organizations.archivedAt))!, names);
}

// ─── Parent organization on many organizations ───────────────────────────

/**
 * Puts the selected organizations under one parent organization, or takes
 * them out of theirs when `parentId` is null, and writes history for each one
 * that changed. Organizations that are parents themselves can't be part of
 * another, so they're left as they are and counted in `skipped`.
 */
export async function setParentOrganization(a: Actor, ids: string[], parentId: string | null) {
  assertCan(a, "records:write");
  const list = z.array(id).min(1).max(500).parse(ids);
  const target = id.nullable().parse(parentId);
  const db = await getDb();
  if (target) {
    const [parent] = await db.select({ name: organizations.name, isParent: organizations.isParent, archivedAt: organizations.archivedAt }).from(organizations).where(eq(organizations.id, target));
    if (!parent) throw new NotFoundError("That parent organization doesn't exist.");
    if (parent.archivedAt) throw new ConflictError(`${parent.name} is archived. Restore it, or pick another parent organization.`);
    if (!parent.isParent) throw new ConflictError(`${parent.name} isn't marked as a parent organization. Mark it as one on its page first, then pick it here.`);
  }
  const before = await db.select({ id: organizations.id, isParent: organizations.isParent, parentId: organizations.parentId }).from(organizations).where(inArray(organizations.id, list));
  const skipped = target ? before.filter((b) => b.isParent).length : 0;
  const changed = before.filter((b) => !(target && b.isParent) && b.parentId !== target);
  let updated = new Set<string>();
  if (changed.length) {
    const rows = await db
      .update(organizations)
      .set({ parentId: target, updatedAt: new Date() })
      // A parent can't be part of another, even one marked as a parent since the read above.
      .where(
        and(
          inArray(
            organizations.id,
            changed.map((b) => b.id),
          ),
          target ? eq(organizations.isParent, false) : undefined,
        ),
      )
      .returning({ id: organizations.id });
    updated = new Set(rows.map((r) => r.id));
    for (const b of changed.filter((c) => updated.has(c.id))) {
      const changes = await labelRelations([{ field: "parentId", label: orgLabels.parentId, from: b.parentId, to: target }]);
      await recordEvent({ entityType: "organization", entityId: b.id, action: "updated", data: { changes }, ...stamp(a) });
    }
  }
  return { count: before.length, changed: updated.size, skipped: skipped + changed.length - updated.size };
}
