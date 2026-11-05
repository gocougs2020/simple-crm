import { bigint, boolean, date, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { ActivityType, BillingInterval, ClientCategory, ClientHealth, CustomFieldType, EntityType, UserRole } from "@/lib/constants";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** Values of a record's custom fields, keyed by `custom_fields.key`. */
export type CustomValues = Record<string, string | number | boolean | string[] | null>;

/** Per-user interface choices (board vs table, sort, which pipeline). Kept on the user so they follow them across devices. */
export type UserPrefs = {
  clientsView?: "board" | "table";
  /** The last pipeline viewed in each client category. */
  clientPipelines?: Partial<Record<ClientCategory, string>>;
  peopleSort?: string;
  organizationsSort?: string;
  clientsSort?: string;
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
  email: jsonb("email").$type<EmailSettings>().notNull().default({}),
  updatedAt: updatedAt(),
});

/**
 * How the CRM hears about new mail. Set when an admin connects the Resend
 * webhook from Settings → Email domains. RESEND_WEBHOOK_SECRET, when set,
 * takes precedence over the stored secret.
 */
export type EmailSettings = {
  webhookId?: string;
  webhookEndpoint?: string;
  webhookSecret?: string;
};
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

/** Each client category has one or more pipelines of its own stages (prospects: Lead → Proposal; current: Onboarding → Renewal). */
export const pipelines = pgTable("pipelines", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  category: text("category").$type<ClientCategory>().notNull().default("prospective"),
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
    /** Win likelihood, 0–100, used for the weighted value of prospects. */
    probability: integer("probability").notNull().default(0),
    /** Clients sitting in a stage longer than this many days are flagged as needing attention. Null turns it off. */
    rottingDays: integer("rotting_days"),
  },
  (t) => [index("stages_pipeline_idx").on(t.pipelineId, t.position)],
);

/**
 * A client relationship: a prospect, a current client or a past one. The
 * category decides which pipeline it moves through and what its record shows.
 * Moving between categories (signing, leaving, coming back) is recorded in
 * its history.
 */
export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    category: text("category").$type<ClientCategory>().notNull().default("prospective"),
    /** Prospects: what they'd be worth. Whole minor units (cents) so sums never drift. */
    value: bigint("value", { mode: "number" }).notNull().default(0),
    currency: text("currency").notNull().default("USD"),
    pipelineId: uuid("pipeline_id")
      .notNull()
      .references(() => pipelines.id),
    stageId: uuid("stage_id")
      .notNull()
      .references(() => stages.id),
    /** Prospects: when we expect them to sign. */
    expectedCloseDate: date("expected_close_date"),
    /** Client since. Set when they first become current. */
    startedOn: date("started_on"),
    /** Left on. Set when they become past. */
    endedOn: date("ended_on"),
    /** Past clients: why they left. */
    churnReason: text("churn_reason"),
    /** Past clients: whether they'd be open to coming back, for win-back campaigns. */
    openToReturn: boolean("open_to_return").notNull().default(true),
    /** Current clients: how the account is doing. */
    health: text("health").$type<ClientHealth>(),
    /** The Stripe customer (cus_…) whose subscriptions and invoices show on the record. */
    stripeCustomerId: text("stripe_customer_id"),
    /** Free-form labels for organizing and campaign audiences ("2024 cohort", "referral"). */
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    /** Order within the stage column on the board. Fractional ranks avoid renumbering every card on a move. */
    rank: text("rank").notNull().default("m"),
    custom: jsonb("custom").$type<CustomValues>().notNull().default({}),
    stageChangedAt: timestamp("stage_changed_at", { withTimezone: true }).notNull().defaultNow(),
    categoryChangedAt: timestamp("category_changed_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("clients_stage_idx").on(t.stageId, t.rank),
    index("clients_pipeline_idx").on(t.pipelineId, t.category),
    index("clients_category_idx").on(t.category),
    index("clients_person_idx").on(t.personId),
    index("clients_org_idx").on(t.organizationId),
    index("clients_owner_idx").on(t.ownerId),
    index("clients_stripe_idx").on(t.stripeCustomerId),
  ],
);

/** What the workspace sells. Managed in Settings → Services; clients are linked to the ones they use. */
export const services = pgTable("services", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  /** The usual price, in cents. Each client's subscription can differ. */
  price: bigint("price", { mode: "number" }).notNull().default(0),
  interval: text("interval").$type<BillingInterval>().notNull().default("month"),
  position: integer("position").notNull().default(0),
  /** Archived services can't be added to clients, but stay on the ones that have them. */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/**
 * A service a client uses or used. An open row (no `endedOn`) is what they
 * pay for today; ended rows are what a past client had.
 */
export const clientServices = pgTable(
  "client_services",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id),
    price: bigint("price", { mode: "number" }).notNull().default(0),
    interval: text("interval").$type<BillingInterval>().notNull().default("month"),
    startedOn: date("started_on"),
    endedOn: date("ended_on"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("client_services_client_idx").on(t.clientId), index("client_services_service_idx").on(t.serviceId, t.endedOn)],
);

/**
 * Performance numbers for a client, logged over time ("Leads", "Ad spend",
 * "NPS"). Each entry is one value for one period, so the record can show the
 * latest and how it moved.
 */
export const clientMetrics = pgTable(
  "client_metrics",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    value: doublePrecision("value").notNull(),
    /** The day or month the number is for. */
    period: date("period").notNull(),
    note: text("note"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("client_metrics_client_idx").on(t.clientId, t.label, t.period)],
);

// ─── Activity ────────────────────────────────────────────────────────────

/**
 * Everything someone did or plans to do with a record: notes, calls, emails,
 * texts, meetings and tasks. One table keeps the timeline a single query and
 * makes "log a call" and "add a task" the same gesture. An activity can link
 * to a person, an organization and a client at once, and shows on all three.
 * Mail that arrives in a connected inbox becomes an email activity too.
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
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }),
    /** Who logged it. Never changes. Null for mail that arrived in an inbox by itself. */
    userId: uuid("user_id").references(() => users.id),
    /** Who it's assigned to (tasks, planned calls). Defaults to the author. */
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    /** Set when the activity is an email the CRM sent. */
    emailId: uuid("email_id").references((): AnyPgColumn => outboundEmails.id, { onDelete: "set null" }),
    /** Set when the activity is a message in a connected inbox, so the timeline can open the conversation. */
    inboxThreadId: uuid("inbox_thread_id").references((): AnyPgColumn => inboxThreads.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("activities_person_idx").on(t.personId, t.createdAt),
    index("activities_org_idx").on(t.organizationId, t.createdAt),
    index("activities_client_idx").on(t.clientId, t.createdAt),
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
    /** e.g. "created", "updated", "stage_changed", "category_changed", "service_added", "file_deleted". */
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
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("files_person_idx").on(t.personId), index("files_org_idx").on(t.organizationId), index("files_client_idx").on(t.clientId)],
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
  /** People connected to a client in one of these categories (the client's contact, or anyone at its organization). */
  clientCategories?: ClientCategory[];
  /** …in one of these stages. */
  stageIds?: string[];
  /** …with one of these client tags. */
  clientTags?: string[];
  /** …who use (or, for past clients, used) one of these services. */
  serviceIds?: string[];
  /** …past clients who left for one of these reasons. */
  churnReasons?: string[];
  /** Leave out past clients marked as not open to coming back. */
  openToReturnOnly?: boolean;
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

// ─── Inbox ───────────────────────────────────────────────────────────────

/**
 * A conversation in one of the workspace's Resend inboxes, mirrored here so
 * it can be linked to people and clients and searched without a round trip.
 * Resend stays the source of truth; the webhook and the sync keep this fresh.
 */
export const inboxThreads = pgTable(
  "inbox_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resendThreadId: text("resend_thread_id").notNull(),
    resendInboxId: text("resend_inbox_id").notNull(),
    inboxAddress: text("inbox_address").notNull(),
    subject: text("subject"),
    snippet: text("snippet"),
    /** The other side's addresses, lowercased: everyone on the thread except our inboxes. */
    participants: jsonb("participants").$type<string[]>().notNull().default([]),
    folder: text("folder").$type<"inbox" | "archive" | "spam" | "sent" | "trash">().notNull().default("inbox"),
    read: boolean("read").notNull().default(false),
    messageCount: integer("message_count").notNull().default(0),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    /** Who it's about. Filled in from the participants' addresses; anyone can change it. */
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    /** Set once someone links the thread by hand, so a later sync doesn't undo it. */
    linkedByHand: boolean("linked_by_hand").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("inbox_threads_resend_idx").on(t.resendThreadId),
    index("inbox_threads_inbox_idx").on(t.resendInboxId, t.folder, t.lastMessageAt),
    index("inbox_threads_person_idx").on(t.personId),
    index("inbox_threads_org_idx").on(t.organizationId),
    index("inbox_threads_client_idx").on(t.clientId),
  ],
);

/** One email in a thread, in either direction. Each one is also an email activity on the linked records' timelines. */
export const inboxMessages = pgTable(
  "inbox_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => inboxThreads.id, { onDelete: "cascade" }),
    resendEmailId: text("resend_email_id").notNull(),
    direction: text("direction").$type<"inbound" | "outbound">().notNull(),
    from: text("from").notNull(),
    to: jsonb("to").$type<string[]>().notNull().default([]),
    cc: jsonb("cc").$type<string[]>().notNull().default([]),
    subject: text("subject"),
    /** Sanitized HTML (src/lib/safe-html.ts). */
    html: text("html"),
    text: text("text"),
    attachments: jsonb("attachments").$type<{ id: string; filename: string | null; size: number | null }[]>().notNull().default([]),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    activityId: uuid("activity_id").references(() => activities.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("inbox_messages_resend_idx").on(t.resendEmailId), index("inbox_messages_thread_idx").on(t.threadId, t.sentAt)],
);

// ─── Imports from other CRMs ─────────────────────────────────────────────

/**
 * Which record here came from which record in another system (Pipedrive, for
 * now). Lets an import run again and update what it brought in instead of
 * duplicating it, and lets it be removed cleanly. `kind` is the other
 * system's record type ("organization", "deal", "note", …); one local record
 * can stand for several of theirs (an organization's deals collapse into one
 * client).
 */
export const externalIds = pgTable(
  "external_ids",
  {
    source: text("source").$type<"pipedrive">().notNull(),
    kind: text("kind").notNull(),
    externalId: text("external_id").notNull(),
    localId: uuid("local_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.source, t.kind, t.externalId] }), index("external_ids_local_idx").on(t.localId)],
);
