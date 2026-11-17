import "server-only";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import type { EntityType } from "@/lib/constants";
import { actorUserId, assertCan, stamp, type Actor } from "@/lib/crm/actor";
import { cleanCustomValues } from "@/lib/crm/custom-fields";
import { appConfig } from "@/app.config";
import { diff, labelRelations, recordEvent } from "@/lib/crm/events";
import { withCustomChanges } from "@/lib/crm/inputs";
import { distinct, emailKey, phoneKey } from "@/lib/crm/merge";
import { id, orgInput, personInput } from "@/lib/crm/schemas";
import { ConflictError, NotFoundError } from "@/lib/errors";
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
  tags: "Tags",
  marketingOptIn: "Email opt-in",
  decisionMaker: appConfig.records.keyContactLabel,
  textConsent: "Agreed to marketing texts",
} as const;

/** `textConsent` is a yes/no in the API; the record keeps when it was given. */
function consentColumns(textConsent: boolean | undefined, before?: Date | null) {
  if (textConsent === undefined) return {};
  return { textConsentAt: textConsent ? (before ?? new Date()) : null };
}
const orgLabels = { name: "Name", domain: "Website", phone: "Phone", address: "Address", industry: "Industry", ownerId: "Owner" } as const;

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

export async function insertOrganization(a: Actor, input: z.input<typeof orgInput>) {
  const data = orgInput.parse(input);
  await assertUser(data.ownerId, "owner");
  const db = await getDb();
  const [row] = await db
    .insert(organizations)
    .values({ ...data, ownerId: ownerFor(a, data.ownerId), custom: data.custom ? await cleanCustomValues("organization", data.custom) : {}, createdBy: actorUserId(a) })
    .returning({ id: organizations.id, name: organizations.name });
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
  const custom = data.custom ? { ...before.custom, ...(await cleanCustomValues("organization", data.custom)) } : undefined;
  await db.update(organizations).set({ ...data, custom, updatedAt: new Date() }).where(eq(organizations.id, before.id));
  const changes = [...diff(before, { ...data, custom: undefined }, orgLabels), ...(await withCustomChanges("organization", before.custom, custom))];
  if (changes.length) await recordEvent({ entityType: "organization", entityId: before.id, action: "updated", data: { changes }, ...stamp(a) });
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
  await db
    .update(people)
    .set({ ...data, ...consentColumns(textConsent, before.textConsentAt), custom, ...(newAddress ? { emailBouncedAt: null } : {}), updatedAt: new Date() })
    .where(eq(people.id, before.id));
  const changes = [
    ...(await labelRelations(diff({ ...before, textConsent: !!before.textConsentAt }, { ...data, ...(textConsent !== undefined ? { textConsent } : {}), custom: undefined }, personLabels))),
    ...(await withCustomChanges("person", before.custom, custom)),
  ];
  if (changes.length) await recordEvent({ entityType: "person", entityId: before.id, action: "updated", data: { changes }, ...stamp(a) });
  if (data.ownerId !== undefined) recordAssigned(a, { entity: "person", id: before.id, name: [data.firstName ?? before.firstName, data.lastName ?? before.lastName].filter(Boolean).join(" ") || "a contact", ownerId: data.ownerId, previousOwnerId: before.ownerId });
  // New numbers, main or other: conversations with them that nobody had move onto this person.
  const had = new Set([before.phone, ...before.otherPhones].map((p) => matchKey(p)));
  await adoptThreadsForPhones([data.phone, ...(data.otherPhones ?? [])].filter((p) => p && !had.has(matchKey(p))));
  return { id: before.id };
}

// ─── Archive (soft delete) ───────────────────────────────────────────────

const tables = { person: people, organization: organizations, client: clients } as const;

/** Archived records disappear from lists and search but keep their history. Restoring brings them back. */
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
  for (const r of rows) await recordEvent({ entityType: entity, entityId: r.id, action: archived ? "archived" : "restored", ...stamp(a) });
  return { count: rows.length, ids: rows.map((r) => r.id) };
}
