import { z } from "zod";
import { churnReasons, clientCategories, clientCategoryLabels, clientHealthLabels, clientHealths, type CustomFieldType, type EntityType } from "@/lib/constants";
import { productFamilies } from "@/lib/product-rules";
import { billingStatuses, billingStatusLabels } from "@/lib/stripe/rules";

/**
 * Saved filters: named sets of conditions on the People, Organizations and
 * Clients lists, like Pipedrive's. A condition reads a field of the record
 * itself or of a record tied to it (a person's organization, an
 * organization's people, a client's organization…), so "people at an
 * organization in the Eastern time zone" is one condition. Pure, so the
 * filter builder and the server agree on fields and operators; the SQL is
 * in src/lib/crm/saved-filters.ts.
 */

/** How a field is compared. */
export type FieldKind = "text" | "number" | "money" | "date" | "choice" | "multi" | "boolean";

export const operators = [
  "is",
  "is_not",
  "contains",
  "not_contains",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "before",
  "after",
  "within_days",
  "not_within_days",
  "next_days",
  "any_of",
  "none_of",
  "has_any",
  "has_all",
  "has_none",
  "is_true",
  "is_false",
  "not_empty",
  "empty",
] as const;
export type Operator = (typeof operators)[number];

/** What each operator is called in the builder, by the kind of field it's on. */
export const operatorLabels: Record<Operator, string> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  not_contains: "doesn't contain",
  eq: "=",
  neq: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  before: "is before",
  after: "is after",
  within_days: "in the last",
  not_within_days: "not in the last",
  next_days: "in the next",
  any_of: "is any of",
  none_of: "is none of",
  has_any: "has any of",
  has_all: "has all of",
  has_none: "has none of",
  is_true: "is yes",
  is_false: "is no",
  not_empty: "is set",
  empty: "is empty",
};

export const kindOperators: Record<FieldKind, readonly Operator[]> = {
  text: ["contains", "not_contains", "is", "is_not", "not_empty", "empty"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "not_empty", "empty"],
  money: ["eq", "neq", "gt", "gte", "lt", "lte", "not_empty", "empty"],
  date: ["within_days", "not_within_days", "next_days", "before", "after", "not_empty", "empty"],
  choice: ["any_of", "none_of", "not_empty", "empty"],
  multi: ["has_any", "has_all", "has_none", "not_empty", "empty"],
  boolean: ["is_true", "is_false"],
};

/**
 * Each operator that rules records out is the opposite of one that picks
 * them: "is not" is "not (is)". Against a related record that means none of
 * them match ("no one at it is a decision maker"), and a person with no
 * organization is "not in the Eastern time zone" and has an empty time zone.
 */
export const negations: Partial<Record<Operator, Operator>> = {
  is_not: "is",
  not_contains: "contains",
  neq: "eq",
  not_within_days: "within_days",
  none_of: "any_of",
  has_none: "has_any",
  is_false: "is_true",
  empty: "not_empty",
};

/** What the value input asks for. */
export function valueShape(op: Operator): "none" | "text" | "number" | "date" | "days" | "list" {
  if (["is_true", "is_false", "not_empty", "empty"].includes(op)) return "none";
  if (["within_days", "not_within_days", "next_days"].includes(op)) return "days";
  if (op === "before" || op === "after") return "date";
  if (["any_of", "none_of", "has_any", "has_all", "has_none"].includes(op)) return "list";
  if (["eq", "neq", "gt", "gte", "lt", "lte"].includes(op)) return "number";
  return "text";
}

/** Where a field's choices come from: fixed ones, or app-wide data the builder already has. */
export type OptionSource = "team" | "pipelines" | "stages" | "parents" | "personLabels" | "organizationLabels" | "clientLabels" | "stripeProducts" | { value: string; label: string }[];

export type FieldMeta = { key: string; label: string; kind: FieldKind; options?: OptionSource };

const choices = (values: readonly string[], label: (v: string) => string = (v) => v) => values.map((value) => ({ value, label: label(value) }));

/** The fields every list can filter on besides custom fields, keyed `<entity>.<field>`. */
export const builtInFields: Record<EntityType, FieldMeta[]> = {
  person: [
    { key: "person.name", label: "Name", kind: "text" },
    { key: "person.email", label: "Email", kind: "text" },
    { key: "person.phone", label: "Phone", kind: "text" },
    { key: "person.title", label: "Job title", kind: "text" },
    { key: "person.owner", label: "Owner", kind: "choice", options: "team" },
    { key: "person.labels", label: "Labels", kind: "multi", options: "personLabels" },
    { key: "person.decisionMaker", label: "Decision maker", kind: "boolean" },
    { key: "person.emailOptIn", label: "Gets email campaigns", kind: "boolean" },
    { key: "person.created", label: "Added", kind: "date" },
    { key: "person.lastActivity", label: "Last activity", kind: "date" },
    { key: "person.lastCampaign", label: "Last campaign", kind: "date" },
  ],
  organization: [
    { key: "organization.name", label: "Name", kind: "text" },
    { key: "organization.website", label: "Website", kind: "text" },
    { key: "organization.phone", label: "Phone", kind: "text" },
    { key: "organization.address", label: "Address", kind: "text" },
    { key: "organization.industry", label: "Industry", kind: "text" },
    { key: "organization.owner", label: "Owner", kind: "choice", options: "team" },
    { key: "organization.labels", label: "Labels", kind: "multi", options: "organizationLabels" },
    { key: "organization.parent", label: "Parent organization", kind: "choice", options: "parents" },
    { key: "organization.isParent", label: "Is a parent organization", kind: "boolean" },
    { key: "organization.people", label: "Number of people", kind: "number" },
    { key: "organization.created", label: "Added", kind: "date" },
    { key: "organization.lastActivity", label: "Last activity", kind: "date" },
  ],
  client: [
    { key: "client.name", label: "Name", kind: "text" },
    { key: "client.category", label: "Category", kind: "choice", options: choices(clientCategories, (c) => clientCategoryLabels[c as keyof typeof clientCategoryLabels].one) },
    { key: "client.pipeline", label: "Pipeline", kind: "choice", options: "pipelines" },
    { key: "client.stage", label: "Stage", kind: "choice", options: "stages" },
    { key: "client.owner", label: "Owner", kind: "choice", options: "team" },
    { key: "client.value", label: "Potential value", kind: "money" },
    { key: "client.health", label: "Health", kind: "choice", options: choices(clientHealths, (h) => clientHealthLabels[h as keyof typeof clientHealthLabels]) },
    { key: "client.churnReason", label: "Why they left", kind: "choice", options: choices(churnReasons) },
    { key: "client.openToReturn", label: "Open to coming back", kind: "boolean" },
    { key: "client.labels", label: "Labels", kind: "multi", options: "clientLabels" },
    { key: "client.productLines", label: "Product lines", kind: "multi", options: choices(productFamilies) },
    { key: "client.stripeProducts", label: "Stripe products", kind: "multi", options: "stripeProducts" },
    { key: "client.billing", label: "Billing status", kind: "choice", options: choices(billingStatuses, (b) => billingStatusLabels[b as keyof typeof billingStatusLabels]) },
    { key: "client.mrr", label: "Monthly revenue", kind: "money" },
    { key: "client.expectedClose", label: "Expected to sign", kind: "date" },
    { key: "client.startedOn", label: "Client since", kind: "date" },
    { key: "client.endedOn", label: "Left on", kind: "date" },
    { key: "client.stageChanged", label: "In stage since", kind: "date" },
    { key: "client.created", label: "Added", kind: "date" },
    { key: "client.lastActivity", label: "Last activity", kind: "date" },
  ],
};

/** How a custom field is compared, by its type. */
export const customFieldKind: Record<CustomFieldType, FieldKind> = {
  text: "text",
  longtext: "text",
  url: "text",
  email: "text",
  phone: "text",
  number: "number",
  currency: "money",
  date: "date",
  select: "choice",
  multiselect: "multi",
  checkbox: "boolean",
};

export type CustomFieldDef = { entityType: EntityType; key: string; label: string; type: CustomFieldType; options: string[] };

/** A custom field as a filter field: `<entity>.custom.<key>`. */
export const customFieldMeta = (f: CustomFieldDef): FieldMeta => ({
  key: `${f.entityType}.custom.${f.key}`,
  label: f.label,
  kind: customFieldKind[f.type],
  ...(f.type === "select" || f.type === "multiselect" ? { options: choices(f.options) } : {}),
});

/**
 * What a list can filter on, grouped by record: the record's own fields
 * first, then the records tied to it. The group names say how they're tied.
 */
export function fieldGroups(entity: EntityType, custom: CustomFieldDef[]) {
  const fields = (e: EntityType) => [...builtInFields[e], ...custom.filter((f) => f.entityType === e).map(customFieldMeta)];
  const related: Record<EntityType, { entity: EntityType; label: string }[]> = {
    person: [
      { entity: "person", label: "Person" },
      { entity: "organization", label: "Their organization" },
      { entity: "client", label: "Their clients" },
    ],
    organization: [
      { entity: "organization", label: "Organization" },
      { entity: "person", label: "People at it" },
      { entity: "client", label: "Its clients" },
    ],
    client: [
      { entity: "client", label: "Client" },
      { entity: "organization", label: "Its organization" },
      { entity: "person", label: "Its contact" },
    ],
  };
  return related[entity].map((g) => ({ ...g, fields: fields(g.entity) }));
}

/** Finds a field by its key, among the built-in ones and the custom fields given. */
export function findField(key: string, custom: CustomFieldDef[]): (FieldMeta & { entity: EntityType }) | null {
  const [entity, ...rest] = key.split(".");
  if (entity !== "person" && entity !== "organization" && entity !== "client") return null;
  if (rest[0] === "custom") {
    const f = custom.find((c) => c.entityType === entity && c.key === rest.slice(1).join("."));
    return f ? { ...customFieldMeta(f), entity } : null;
  }
  const f = builtInFields[entity].find((b) => b.key === key);
  return f ? { ...f, entity } : null;
}

// ─── Definitions ─────────────────────────────────────────────────────────

const conditionValue = z.union([z.string().trim().max(200), z.number().finite(), z.array(z.string().trim().max(200)).max(100)]);

export const filterCondition = z.object({
  field: z
    .string()
    .max(120)
    .regex(/^(person|organization|client)\.(custom\.)?[A-Za-z0-9_-]+$/, "Pick a field for each condition."),
  op: z.enum(operators),
  value: conditionValue.optional(),
});
export type FilterCondition = z.infer<typeof filterCondition>;

/** Every condition in `all`, and at least one in `any` when it has some. */
export const filterConditions = z.object({
  all: z.array(filterCondition).max(20, "A filter can have up to 20 conditions in each group.").default([]),
  any: z.array(filterCondition).max(20, "A filter can have up to 20 conditions in each group.").default([]),
});
export type FilterConditions = z.infer<typeof filterConditions>;

/**
 * Whether a condition is complete enough to save: its field exists, the
 * operator suits it, and it has the value the operator needs. Returns the
 * sentence to show when it isn't.
 */
export function conditionProblem(c: FilterCondition, custom: CustomFieldDef[]): string | null {
  const field = findField(c.field, custom);
  if (!field) return "One of the conditions uses a field that no longer exists. Pick another field or remove it.";
  if (!kindOperators[field.kind].includes(c.op)) return `"${operatorLabels[c.op]}" doesn't work on ${field.label}. Pick another comparison.`;
  const shape = valueShape(c.op);
  const v = c.value;
  if (shape === "none") return null;
  if (shape === "list") return Array.isArray(v) && v.length ? null : `Pick at least one value for ${field.label}.`;
  if (shape === "days") return typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 36500 ? null : `Enter a number of days for ${field.label}.`;
  if (shape === "date") return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? null : `Pick a date for ${field.label}.`;
  if (shape === "number") return typeof v === "number" && Number.isFinite(v) ? null : `Enter a number for ${field.label}.`;
  return typeof v === "string" && v.trim() ? null : `Enter something to compare ${field.label} with.`;
}

export const conditionCount = (c: FilterConditions) => c.all.length + c.any.length;

/** The fields whose values are label names: renaming a label renames it in conditions on these. */
const labelFields = new Set(["person.labels", "organization.labels", "client.labels"]);

/**
 * A filter's conditions with a renamed label swapped in, or null when no
 * condition names it. Without this a filter on the old name would stop
 * matching ("has any of") or start letting in what it kept out ("has none
 * of"), since records carry the new name. A deleted label needs nothing:
 * nobody carries it any more, which is what its conditions already say.
 */
export function renameLabelInFilter(f: FilterConditions, from: string, to: string): FilterConditions | null {
  let changed = false;
  const swap = (c: FilterCondition): FilterCondition => {
    if (!labelFields.has(c.field) || !Array.isArray(c.value) || !c.value.includes(from)) return c;
    changed = true;
    return { ...c, value: [...new Set(c.value.map((v) => (v === from ? to : v)))] };
  };
  const next = { all: f.all.map(swap), any: f.any.map(swap) };
  return changed ? next : null;
}
