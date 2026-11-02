import "server-only";
import { z } from "zod";
import { getDb, schema } from "@/db";
import type { CustomValues } from "@/db/schema";
import type { EntityType } from "@/lib/constants";
import { cleanCustomValues, customLabels } from "@/lib/crm/custom-fields";
import { diff, recordEvent } from "@/lib/crm/events";

/** Validation shared by the record actions. Kept out of the "use server" files, where every export is an endpoint. */
export const id = z.uuid();
export const optionalId = z.uuid().nullable().optional();
export const name = (label: string, max = 120) => z.string().trim().min(1, `Enter ${label}.`).max(max);
export const optionalText = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => v || null);
export const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(200)
  .nullable()
  .optional()
  .transform((v) => v || null)
  .refine((v) => !v || z.email().safeParse(v).success, "Enter a valid email address.");
export const optionalDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date.")
  .nullable()
  .optional()
  .transform((v) => v || null);
export const tagList = z.array(z.string().trim().toLowerCase().min(1).max(40)).max(30);

export async function withCustomChanges(entity: EntityType, before: CustomValues, after: CustomValues | undefined) {
  if (!after) return [];
  const labels = await customLabels(entity);
  return diff(before, after, labels).map((c) => ({ ...c, field: `custom.${c.field}` }));
}

export const orgInput = z.object({
  name: name("a name"),
  domain: optionalText(200).transform((v) => (v ? v.replace(/^https?:\/\//i, "").replace(/\/$/, "").toLowerCase() : null)),
  phone: optionalText(40),
  address: optionalText(300),
  industry: optionalText(80),
  ownerId: optionalId,
  custom: z.record(z.string(), z.unknown()).optional(),
});

export async function insertOrganization(input: z.input<typeof orgInput>, userId: string) {
  const data = orgInput.parse(input);
  const db = await getDb();
  const [row] = await db
    .insert(schema.organizations)
    .values({ ...data, ownerId: data.ownerId === undefined ? userId : data.ownerId, custom: data.custom ? await cleanCustomValues("organization", data.custom) : {}, createdBy: userId })
    .returning({ id: schema.organizations.id, name: schema.organizations.name });
  await recordEvent({ entityType: "organization", entityId: row.id, action: "created", userId });
  return row;
}

/** "Add 'Sam Lee' as a new person" from a picker: first word is the first name. */
export async function insertPersonByName(fullName: string, organizationId: string | null, userId: string) {
  const db = await getDb();
  const [first, ...rest] = fullName.trim().split(/\s+/);
  const [p] = await db.insert(schema.people).values({ firstName: first, lastName: rest.join(" ") || null, organizationId, ownerId: userId, createdBy: userId }).returning({ id: schema.people.id });
  await recordEvent({ entityType: "person", entityId: p.id, action: "created", userId });
  return p;
}

/** Today in the workspace's time zone, as YYYY-MM-DD. */
export async function workspaceToday() {
  const db = await getDb();
  const [ws] = await db.select({ timezone: schema.workspace.timezone }).from(schema.workspace).limit(1);
  return new Intl.DateTimeFormat("en-CA", { timeZone: ws?.timezone ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
