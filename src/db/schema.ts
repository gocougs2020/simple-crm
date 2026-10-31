import { bigint, boolean, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { ActivityType, CustomFieldType, DealStatus, EntityType, UserRole } from "@/lib/constants";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** Values of a record's custom fields, keyed by `custom_fields.key`. */
export type CustomValues = Record<string, string | number | boolean | string[] | null>;

/** Per-user interface choices (board vs table, sort, which pipeline). Kept on the user so they follow them across devices. */
export type UserPrefs = {
  dealsView?: "board" | "table";
  pipelineId?: string;
  peopleSort?: string;
  organizationsSort?: string;
  dealsSort?: string;
  timelineFilter?: string;
};

// ─── Team and access ─────────────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    /** scrypt hash (src/lib/password.ts). Null until an invited teammate sets a password. */
    passwordHash: text("password_hash"),
    role: text("role").$type<UserRole>().notNull().default("member"),
    title: text("title"),
    prefs: jsonb("prefs").$type<UserPrefs>().notNull().default({}),
    /** Deactivated teammates can't sign in, but everything they did stays attributed to them. */
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

/** Server-side record of each signed-in browser. Deleting a row signs that browser out even though its cookie is still validly signed. */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** Single-use links for invitations and password resets. Only a SHA-256 hash of the token is stored. */
export const authTokens = pgTable(
  "auth_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    kind: text("kind").$type<"invite" | "reset">().notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("auth_tokens_user_idx").on(t.userId)],
);

/** Fixed-window request counters (sign-in attempts per IP and per email). The key holds a hash, never a raw IP or address. */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);

/** One row: the workspace's name, defaults and the brand kit used by email. */
export const workspace = pgTable("workspace", {
  id: integer("id").primaryKey().default(1),
  name: text("name").notNull().default("My company"),
  currency: text("currency").notNull().default("USD"),
  timezone: text("timezone").notNull().default("America/Denver"),
  brand: jsonb("brand").$type<BrandKit>().notNull().default({}),
  updatedAt: updatedAt(),
});

/** What every email from the CRM is wrapped in. Everything is optional; blanks fall back to the workspace name and plain styling. */
export type BrandKit = {
  logoUrl?: string;
  /** Hex color for buttons and links in email only. */
  accentColor?: string;
  senderName?: string;
  replyTo?: string;
  /** Required by CAN-SPAM in marketing email. */
  postalAddress?: string;
  website?: string;
  /** Plain text signature appended to one-off emails, per sender name tokens {{sender_name}}, {{sender_title}}. */
  signature?: string;
};

// ─── Records ─────────────────────────────────────────────────────────────

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    domain: text("domain"),
    phone: text("phone"),
    address: text("address"),
    industry: text("industry"),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    custom: jsonb("custom").$type<CustomValues>().notNull().default({}),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [index("organizations_name_idx").on(t.name), index("organizations_owner_idx").on(t.ownerId)],
);

export const people = pgTable(
  "people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name"),
    email: text("email"),
    phone: text("phone"),
    title: text("title"),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    custom: jsonb("custom").$type<CustomValues>().notNull().default({}),
    /** Campaigns only go to people who haven't opted out. One-off emails from a record always send. */
    marketingOptIn: boolean("marketing_opt_in").notNull().default(true),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("people_org_idx").on(t.organizationId),
    index("people_owner_idx").on(t.ownerId),
    index("people_email_idx").on(t.email),
    index("people_name_idx").on(t.firstName, t.lastName),
  ],
);

export const pipelines = pgTable("pipelines", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  position: integer("position").notNull().default(0),
  createdAt: createdAt(),
});

export const stages = pgTable(
  "stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pipelineId: uuid("pipeline_id")
      .notNull()
      .references(() => pipelines.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    /** Win likelihood, 0–100, used for the weighted value on the board. */
    probability: integer("probability").notNull().default(0),
    /** Deals sitting in a stage longer than this many days are flagged as rotting. Null turns it off. */
    rottingDays: integer("rotting_days"),
  },
  (t) => [index("stages_pipeline_idx").on(t.pipelineId, t.position)],
);

export const deals = pgTable(
  "deals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    /** Whole minor units (cents) so sums never drift. */
    value: bigint("value", { mode: "number" }).notNull().default(0),
    currency: text("currency").notNull().default("USD"),
    pipelineId: uuid("pipeline_id")
      .notNull()
      .references(() => pipelines.id),
    stageId: uuid("stage_id")
      .notNull()
      .references(() => stages.id),
    status: text("status").$type<DealStatus>().notNull().default("open"),
    lostReason: text("lost_reason"),
    expectedCloseDate: date("expected_close_date"),
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    /** Order within the stage column on the board. Fractional ranks avoid renumbering every card on a move. */
    rank: text("rank").notNull().default("m"),
    custom: jsonb("custom").$type<CustomValues>().notNull().default({}),
    stageChangedAt: timestamp("stage_changed_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("deals_stage_idx").on(t.stageId, t.rank),
    index("deals_pipeline_idx").on(t.pipelineId, t.status),
    index("deals_person_idx").on(t.personId),
    index("deals_org_idx").on(t.organizationId),
    index("deals_owner_idx").on(t.ownerId),
  ],
);

// ─── Activity ────────────────────────────────────────────────────────────

/**
 * Everything someone did or plans to do with a record: notes, calls, emails,
 * texts, meetings and tasks. One table keeps the timeline a single query and
 * makes "log a call" and "add a task" the same gesture. An activity can link
 * to a person, an organization and a deal at once, and shows on all three.
 */
export const activities = pgTable(
  "activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").$type<ActivityType>().notNull(),
    subject: text("subject"),
    /** Sanitized rich-text HTML (src/lib/safe-html.ts). */
    body: text("body"),
    /** For calls, emails and texts: did we reach out or did they? */
    direction: text("direction").$type<"outbound" | "inbound">(),
    /** For calls and meetings, e.g. "Connected", "Left voicemail". */
    outcome: text("outcome"),
    durationMinutes: integer("duration_minutes"),
    /** When it happened. For tasks and scheduled meetings this is null until done. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    /** Tasks and planned calls/meetings. */
    dueAt: timestamp("due_at", { withTimezone: true }),
    /** Whether `dueAt` carries a time or only a date. */
    dueHasTime: boolean("due_has_time").notNull().default(false),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    pinned: boolean("pinned").notNull().default(false),
    personId: uuid("person_id").references(() => people.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    dealId: uuid("deal_id").references(() => deals.id, { onDelete: "cascade" }),
    /** Who logged it. Never changes. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** Who it's assigned to (tasks, planned calls). Defaults to the author. */
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    /** Set when the activity is an email the CRM sent. */
    emailId: uuid("email_id").references((): AnyPgColumn => outboundEmails.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("activities_person_idx").on(t.personId, t.createdAt),
    index("activities_org_idx").on(t.organizationId, t.createdAt),
    index("activities_deal_idx").on(t.dealId, t.createdAt),
    index("activities_assignee_due_idx").on(t.assigneeId, t.completedAt, t.dueAt),
  ],
);

/**
 * The record's change history: created, stage moved, won, owner changed, field
 * edited. Written by the server alongside each change, never by hand, so the
 * timeline can answer "who changed this and when".
 */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: text("entity_type").$type<EntityType>().notNull(),
    entityId: uuid("entity_id").notNull(),
    /** e.g. "created", "updated", "stage_changed", "won", "lost", "reopened", "file_added". */
    action: text("action").notNull(),
    /** Field-level detail: { field, label, from, to } entries, or other context for the action. */
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("events_entity_idx").on(t.entityType, t.entityId, t.createdAt)],
);

export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Vercel Blob URL, or a /api/files/local/... path in local development. */
    url: text("url").notNull(),
    pathname: text("pathname").notNull(),
    size: integer("size").notNull(),
    contentType: text("content_type").notNull(),
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    dealId: uuid("deal_id").references(() => deals.id, { onDelete: "set null" }),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("files_person_idx").on(t.personId), index("files_org_idx").on(t.organizationId), index("files_deal_idx").on(t.dealId)],
);

export const customFields = pgTable(
  "custom_fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityType: text("entity_type").$type<EntityType>().notNull(),
    /** Stable key used in each record's `custom` JSON. Never changes after creation, so renaming a field keeps its data. */
    key: text("key").notNull(),
    label: text("label").notNull(),
    type: text("type").$type<CustomFieldType>().notNull(),
    options: jsonb("options").$type<string[]>().notNull().default([]),
    position: integer("position").notNull().default(0),
    /** Show as a column in the table view by default. */
    showInTable: boolean("show_in_table").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("custom_fields_key_idx").on(t.entityType, t.key)],
);

// ─── Email ───────────────────────────────────────────────────────────────

/** Reusable emails. `body` is rich-text HTML with merge tags; the brand kit wraps it when sent. */
export const emailTemplates = pgTable("email_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  subject: text("subject").notNull().default(""),
  body: text("body").notNull().default(""),
  /** Shared templates show for everyone; personal ones only for their author. */
  shared: boolean("shared").notNull().default(true),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Who a campaign goes to. Evaluated at send time, so people added later are included. */
export type CampaignAudience = {
  tags?: string[];
  ownerIds?: string[];
  organizationIds?: string[];
  /** People with an open deal in one of these stages. */
  stageIds?: string[];
  /** A fixed list instead of filters. */
  personIds?: string[];
};

export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    subject: text("subject").notNull().default(""),
    previewText: text("preview_text"),
    /** The body as written: sanitized rich-text HTML with merge tags. */
    body: text("body").notNull().default(""),
    /** The full email (brand kit layout around the body) rendered on every save, so sending never needs React. */
    html: text("html"),
    audience: jsonb("audience").$type<CampaignAudience>().notNull().default({}),
    status: text("status").$type<"draft" | "scheduled" | "sending" | "sent">().notNull().default("draft"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    sendError: text("send_error"),
    recipientCount: integer("recipient_count").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("campaigns_status_idx").on(t.status, t.scheduledAt)],
);

/** Every email the CRM sent: one-off emails from a record and each campaign recipient. */
export const outboundEmails = pgTable(
  "outbound_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    to: text("to").notNull(),
    cc: text("cc"),
    subject: text("subject").notNull(),
    resendId: text("resend_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("outbound_emails_person_idx").on(t.personId),
    uniqueIndex("outbound_emails_campaign_person_idx").on(t.campaignId, t.personId),
  ],
);

/** Each spreadsheet import, with what it created and changed, so it can be undone. */
export const peopleImports = pgTable("people_imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  fileName: text("file_name").notNull(),
  createdIds: jsonb("created_ids").$type<string[]>().notNull().default([]),
  createdOrgIds: jsonb("created_org_ids").$type<string[]>().notNull().default([]),
  /** Notes the import added to people who already existed (new people's notes go with them on undo). */
  createdActivityIds: jsonb("created_activity_ids").$type<string[]>().notNull().default([]),
  updates: jsonb("updates").$type<{ id: string; before: Record<string, unknown> }[]>().notNull().default([]),
  created: integer("created").notNull().default(0),
  updated: integer("updated").notNull().default(0),
  unchanged: integer("unchanged").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
});
