import { z } from "zod";
import { activityTypes, apiKeyKinds, billingIntervals, clientCategories, clientHealths, customFieldTypes, entityTypes, userRoles } from "@/lib/constants";
import { permissions } from "@/lib/permissions";

/**
 * The shapes the API returns, for the OpenAPI document and the docs page.
 * The serializers in serialize.ts produce exactly these. Money is integer
 * cents, dates are YYYY-MM-DD, and times are ISO 8601 in UTC.
 */

const uuid = z.uuid();
const ts = z.iso.datetime().describe("ISO 8601, UTC.");
const day = z.string().describe("YYYY-MM-DD.");
const ref = z.object({ id: uuid, name: z.string() });
const custom = z.record(z.string(), z.unknown()).describe("Custom field values keyed by field key.");

export const Person = z.object({
  id: uuid,
  firstName: z.string(),
  lastName: z.string().nullable(),
  name: z.string().describe("First and last name together."),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  title: z.string().nullable(),
  organizationId: uuid.nullable(),
  organization: ref.nullable(),
  ownerId: uuid.nullable(),
  tags: z.array(z.string()),
  marketingOptIn: z.boolean(),
  unsubscribedAt: ts.nullable(),
  emailBouncedAt: ts.nullable().describe("When an email to this address bounced for good. Campaigns skip the person until the address changes."),
  lastCampaignAt: ts.nullable().describe("When a campaign last went to them. Campaigns don't change lastActivityAt, which is personal outreach only."),
  custom,
  lastActivityAt: ts.nullable(),
  createdAt: ts,
  updatedAt: ts,
  archivedAt: ts.nullable(),
  url: z.string().describe("Where the record opens in the CRM."),
});

export const Organization = z.object({
  id: uuid,
  name: z.string(),
  domain: z.string().nullable(),
  phone: z.string().nullable(),
  address: z.string().nullable(),
  industry: z.string().nullable(),
  ownerId: uuid.nullable(),
  peopleCount: z.number().int(),
  custom,
  lastActivityAt: ts.nullable(),
  createdAt: ts,
  updatedAt: ts,
  archivedAt: ts.nullable(),
  url: z.string(),
});

export const Client = z.object({
  id: uuid,
  name: z.string(),
  category: z.enum(clientCategories),
  value: z.number().int().describe("Prospects: potential value, in cents."),
  currency: z.string(),
  mrr: z.number().int().describe("Monthly revenue from open services, in cents. Derived, never stored."),
  pipeline: ref,
  stage: ref.extend({ probability: z.number().int() }),
  stageChangedAt: ts,
  expectedCloseDate: day.nullable(),
  startedOn: day.nullable(),
  endedOn: day.nullable(),
  churnReason: z.string().nullable(),
  openToReturn: z.boolean(),
  health: z.enum(clientHealths).nullable(),
  stripeCustomerId: z.string().nullable(),
  tags: z.array(z.string()),
  personId: uuid.nullable(),
  person: ref.nullable(),
  organizationId: uuid.nullable(),
  organization: ref.nullable(),
  ownerId: uuid.nullable(),
  custom,
  lastActivityAt: ts.nullable(),
  createdAt: ts,
  updatedAt: ts,
  archivedAt: ts.nullable(),
  url: z.string(),
});

export const Activity = z.object({
  id: uuid,
  type: z.enum(activityTypes),
  status: z.enum(["planned", "done"]).describe("planned: open with a due date. done: completed, or logged as something that happened."),
  subject: z.string().nullable(),
  body: z.string().nullable().describe("Sanitized HTML."),
  bodyText: z.string().nullable().describe("The body as plain text."),
  direction: z.enum(["outbound", "inbound"]).nullable(),
  outcome: z.string().nullable(),
  durationMinutes: z.number().int().nullable(),
  occurredAt: ts.nullable(),
  dueAt: ts.nullable(),
  dueHasTime: z.boolean(),
  completedAt: ts.nullable(),
  pinned: z.boolean(),
  personId: uuid.nullable(),
  person: ref.nullable(),
  organizationId: uuid.nullable(),
  organization: ref.nullable(),
  clientId: uuid.nullable(),
  client: ref.nullable(),
  userId: uuid.nullable().describe("Who logged it. Null for inbox mail and workspace API keys."),
  assigneeId: uuid.nullable(),
  apiKeyId: uuid.nullable().describe("The API key it was logged through, if any."),
  createdAt: ts,
  updatedAt: ts,
});

export const HistoryEvent = z.object({
  id: uuid,
  action: z.string().describe('What happened: "created", "updated", "stage_changed", "category_changed", "archived", …'),
  data: z.record(z.string(), z.unknown()).describe("Detail. For updated: { changes: [{ field, label, from, to }] }."),
  userId: uuid.nullable(),
  apiKeyId: uuid.nullable(),
  createdAt: ts,
});

export const Timeline = z.object({
  planned: z.array(Activity).describe("Open tasks and planned activity, soonest first."),
  history: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("activity"), at: ts, activity: Activity }),
        z.object({ kind: z.literal("event"), at: ts, event: HistoryEvent }),
        z.object({ kind: z.literal("file"), at: ts, file: z.object({ id: uuid, name: z.string(), size: z.number().int(), contentType: z.string() }) }),
      ]),
    )
    .describe("Logged activity, changes and files, newest first (pinned activity first)."),
  lastContactAt: ts.nullable().describe("The latest call, email, text or meeting."),
});

export const Stage = z.object({ id: uuid, name: z.string(), position: z.number().int(), probability: z.number().int(), rottingDays: z.number().int().nullable() });
export const Pipeline = z.object({ id: uuid, name: z.string(), category: z.enum(clientCategories), position: z.number().int(), stages: z.array(Stage) });

export const Service = z.object({
  id: uuid,
  name: z.string(),
  description: z.string().nullable(),
  price: z.number().int().describe("Catalog price, in cents."),
  interval: z.enum(billingIntervals),
  archived: z.boolean(),
});

export const ClientService = z.object({
  id: uuid.describe("The subscription's own id (not the service's)."),
  serviceId: uuid,
  name: z.string(),
  price: z.number().int().describe("In cents."),
  interval: z.enum(billingIntervals),
  startedOn: day.nullable(),
  endedOn: day.nullable(),
  active: z.boolean(),
  note: z.string().nullable(),
});

export const Metric = z.object({ id: uuid, label: z.string(), value: z.number(), period: day, note: z.string().nullable(), userId: uuid.nullable(), createdAt: ts });

export const User = z.object({ id: uuid, name: z.string(), email: z.string(), role: z.enum(userRoles), title: z.string().nullable(), active: z.boolean() });

export const CustomField = z.object({
  id: uuid,
  entityType: z.enum(entityTypes),
  key: z.string().describe("Use this key in a record's custom object. It never changes."),
  label: z.string(),
  type: z.enum(customFieldTypes),
  options: z.array(z.string()).describe("Choices for select and multiselect fields."),
});

export const Me = z.object({
  kind: z.enum(apiKeyKinds),
  key: z.object({ id: uuid, name: z.string(), prefix: z.string(), expiresAt: ts.nullable() }),
  user: User.nullable().describe("The teammate a personal key acts as. Null for workspace keys."),
  permissions: z.array(z.enum(permissions)),
  workspace: z.object({ name: z.string(), currency: z.string(), timezone: z.string() }),
});

export const SearchResult = z.object({
  people: z.array(Person),
  organizations: z.array(Organization),
  clients: z.array(Client),
});

export const Deleted = z.object({ id: uuid, deleted: z.literal(true) });

export const Knowledge = z.object({
  source: z.string().describe("The knowledge source's name."),
  path: z.string().describe("The path that was read, relative to the source's base, with its query."),
  url: z.string().describe("The full URL that was read (the key is never part of it)."),
  content: z.unknown().describe("What the source returned: its JSON as is, or text."),
});

/** Named schemas, in the order the docs list them. */
export const models = { Person, Organization, Client, Activity, Timeline, HistoryEvent, Pipeline, Stage, Service, ClientService, Metric, User, CustomField, Me, SearchResult, Knowledge, Deleted } as const;
export type ModelName = keyof typeof models;
