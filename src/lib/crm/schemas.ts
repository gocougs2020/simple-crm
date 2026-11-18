import { z } from "zod";
import { agentDraftKinds, activityTypes, billingIntervals, clientCategories, clientHealths } from "@/lib/constants";

/**
 * Validation for record changes, shared by the server actions, the REST API
 * and MCP. Pure (no server imports): the API docs and the MCP tool list are
 * generated from these schemas, so descriptions here are what developers and
 * agents read.
 */

export const id = z.uuid();
export const optionalId = z.uuid().nullable().optional();
export const name = (label: string, max = 120) =>
  z
    .string({ error: `Enter ${label}.` })
    .trim()
    .min(1, `Enter ${label}.`)
    .max(max);
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
const customValues = z.record(z.string(), z.unknown()).describe("Custom field values keyed by field key (see GET /custom-fields). Unknown keys are ignored; values are checked against each field's type.");

// ─── People ──────────────────────────────────────────────────────────────

export const personInput = z.object({
  firstName: name("a first name", 80).describe("Required when creating."),
  lastName: optionalText(80),
  email: optionalEmail.describe("Unique among people who aren't archived."),
  phone: optionalText(40),
  otherEmails: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .max(200)
        .refine((v) => z.email().safeParse(v).success, "Enter valid email addresses, separated by commas."),
    )
    .max(20)
    .optional()
    .describe("More addresses for the same person, besides email. Replaces the whole list."),
  otherPhones: z.array(z.string().trim().min(1).max(40)).max(20).optional().describe("More numbers for the same person, besides phone. Replaces the whole list."),
  title: optionalText(120).describe("Job title."),
  organizationId: optionalId.describe("The organization they work at."),
  ownerId: optionalId.describe("The teammate who owns the relationship. Defaults to whoever creates it; null for none."),
  tags: tagList.optional().describe("Lowercase labels. Replaces the whole list."),
  marketingOptIn: z.boolean().optional().describe("Whether campaigns may go to them. One-off emails always send."),
  decisionMaker: z.boolean().optional().describe("Star them at their organization as someone who makes or signs off on the decision."),
  textConsent: z.boolean().optional().describe("Whether they agreed to receive marketing texts (text campaigns). Setting it records when; one-to-one texts don't need it."),
  custom: customValues.optional(),
});

// ─── Organizations ───────────────────────────────────────────────────────

export const orgInput = z.object({
  name: name("a name").describe("Required when creating."),
  domain: optionalText(200)
    .transform((v) => (v ? v.replace(/^https?:\/\//i, "").replace(/\/$/, "").toLowerCase() : null))
    .describe("Website, without https://. Used to match inbox mail to the organization."),
  phone: optionalText(40),
  address: optionalText(300),
  industry: optionalText(80),
  isParent: z
    .boolean()
    .optional()
    .describe("Mark it as a parent organization: one that others can be part of (a franchisor and its franchises, a group and its offices). Only parent organizations can be another's parentId."),
  parentId: optionalId.describe("The parent organization this one is part of. Must be an organization with isParent true; a parent organization can't have a parent itself. null for none."),
  ownerId: optionalId.describe("The teammate who owns the relationship. Defaults to whoever creates it; null for none."),
  custom: customValues.optional(),
});

// ─── Clients ─────────────────────────────────────────────────────────────

export const clientInput = z.object({
  name: name("a name", 160).describe("Required when creating."),
  value: z.number().int().min(0).max(1e15).optional().describe("Prospects: what they'd be worth, in cents (12500 is 125.00)."),
  personId: optionalId.describe("The main contact."),
  organizationId: optionalId.describe("Filled in from the contact's organization when left out."),
  ownerId: optionalId.describe("The teammate who owns the account. Defaults to whoever creates it; null for none."),
  expectedCloseDate: optionalDate.describe("Prospects: when we expect them to sign (YYYY-MM-DD)."),
  startedOn: optionalDate.describe("Client since (YYYY-MM-DD)."),
  endedOn: optionalDate.describe("Past clients: when they left (YYYY-MM-DD)."),
  churnReason: optionalText(300).describe("Past clients: why they left."),
  openToReturn: z.boolean().optional().describe("Past clients: whether they'd consider coming back."),
  health: z.enum(clientHealths).nullable().optional().describe("Current clients: how the account is doing."),
  tags: tagList.optional().describe("Lowercase labels. Replaces the whole list."),
  custom: customValues.optional(),
});

export const clientCreateInput = clientInput.extend({
  category: z.enum(clientCategories).describe("prospective, current or past. Decides which pipelines it can move through."),
  stageId: optionalId.describe("A stage in one of the category's pipelines. Defaults to the first stage of the first pipeline."),
  serviceIds: z.array(id).max(50).optional().describe("Current and past clients: services they use (or used), at the catalog price."),
});

export const moveInput = z.object({
  stageId: id.describe("A stage in a pipeline of the client's own category. To change category, use the category endpoint."),
});

export const categoryInput = z.object({
  category: z.enum(clientCategories),
  stageId: z.uuid().nullable().optional().describe("Where it lands. Defaults to the first stage of the category's first pipeline."),
  /** Becoming current: client since. Becoming past: left on. Defaults to today. */
  on: optionalDate.describe("Becoming current: client since. Becoming past: left on. Defaults to today in the workspace's time zone."),
  churnReason: optionalText(300).describe("Becoming past: why they left."),
  openToReturn: z.boolean().optional().describe("Becoming past: whether they'd consider coming back."),
  endServices: z.boolean().optional().describe("Becoming past: end the services they still have, on the same day. Defaults to true."),
  serviceIds: z.array(z.uuid()).max(50).optional().describe("Becoming current: start these services."),
});

export const subscriptionInput = z.object({
  price: z.number().int().min(0).max(1e13).optional().describe("In cents. Defaults to the service's catalog price."),
  interval: z.enum(billingIntervals).optional().describe("Defaults to the service's interval."),
  startedOn: optionalDate,
  endedOn: optionalDate.describe("Set to end the service. Ended services stop counting toward monthly revenue."),
  note: optionalText(300),
});

export const metricInput = z.object({
  label: z.string().trim().min(1, "Name what you're measuring.").max(60).describe('What is measured, like "Leads". The same label (any capitalization) is one series.'),
  value: z.number({ error: "Enter the number." }).finite().min(-1e12).max(1e12),
  period: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Pick the date this number is for.")
    .describe("The day or month the number is for (YYYY-MM-DD)."),
  note: optionalText(300),
});

// ─── Activities ──────────────────────────────────────────────────────────

/** A moment in time. The offset matters: it's what makes "3pm" mean the right 3pm. */
export const datetime = z.iso.datetime({ offset: true, error: "Use an ISO 8601 time with an offset, like 2026-05-01T15:00:00-06:00." });

export const activityInput = z.object({
  type: z.enum(activityTypes).describe("note, call, email, text, meeting or task."),
  subject: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .optional()
    .transform((v) => v || null)
    .describe("A short title. Tasks need a subject or a body."),
  body: z.string().max(100_000).nullable().optional().describe("Rich text as HTML (p, strong, em, a, ul, ol, li, blockquote, code). Anything else is stripped. Plain text is fine."),
  direction: z.enum(["outbound", "inbound"]).nullable().optional().describe("Calls, emails and texts: did we reach out, or did they?"),
  outcome: z.string().trim().max(80).nullable().optional().describe('Calls and meetings, like "Connected" or "Left voicemail".'),
  durationMinutes: z.number().int().min(0).max(24 * 60).nullable().optional(),
  occurredAt: datetime.nullable().optional().describe("When it happened (ISO 8601 with offset). Defaults to now for things logged as done."),
  dueAt: datetime.nullable().optional().describe("Tasks and planned calls or meetings: when it's due (ISO 8601 with offset)."),
  dueHasTime: z.boolean().optional().describe("Whether dueAt carries a time of day, or only the date matters."),
  assigneeId: z.uuid().nullable().optional().describe("Who it's assigned to. Defaults to whoever creates it."),
  personId: z.uuid().nullable().optional(),
  organizationId: z.uuid().nullable().optional(),
  clientId: z.uuid().nullable().optional().describe("Linking a client also links its contact and organization; linking a person also links their organization."),
  agent: z
    .boolean()
    .optional()
    .describe("Tasks: true hands the task to the CRM's agent, which does the work in the background as you, adds its answer to the task and marks it done. Needs background work set up on the deployment."),
  /** Logging something that already happened (a call you just made) vs planning it. */
  done: z.boolean().optional().describe("true logs something that already happened; false plans it. Defaults to false for tasks and anything with a dueAt, true otherwise."),
});

export type ActivityInput = z.input<typeof activityInput>;

// ─── Drafts ──────────────────────────────────────────────────────────────

/** An email or text written for a teammate to review and send (src/lib/crm/service/drafts.ts). */
export const draftInput = z.object({
  kind: z.enum(agentDraftKinds).describe("email or text."),
  personId: z.uuid().describe("Who it's to. They need an email address (for an email) or a phone number (for a text) on their record."),
  clientId: z.uuid().nullable().optional().describe("The client it's about, if one, so the sent message lands on its timeline too."),
  subject: z.string().trim().max(200).nullable().optional().describe("Emails: the subject line."),
  body: z.string().trim().min(1, "Write the message first.").max(50_000).describe("The message. Emails: plain text or simple HTML (p, strong, em, a, ul, ol, li). Texts: plain text, up to 1,600 characters. Merge tags like {{first_name}} work in emails."),
});
export type DraftInput = z.input<typeof draftInput>;
