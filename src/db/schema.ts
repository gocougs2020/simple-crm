import { sql } from "drizzle-orm";
import { bigint, boolean, date, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, vector, type AnyPgColumn } from "drizzle-orm/pg-core";
import type {
  ActivityType,
  AgentDraftKind,
  AgentDraftStatus,
  AgentRunSource,
  AgentRunStatus,
  AgentScope,
  AgentSkillMode,
  ScheduleEvery,
  ApiKeyKind,
  BillingInterval,
  CalendarSharing,
  CampaignChannel,
  ClientCategory,
  ClientHealth,
  CustomFieldType,
  EmailDigestKind,
  EmailForwardStatus,
  EntityType,
  NotificationKind,
  UserRole,
} from "@/lib/constants";
import type { BillingStatus } from "@/lib/stripe/rules";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/**
 * An AI snapshot of the record, shown at the top of its page and shared by
 * everyone who opens it: who they are, what happened lately, what needs
 * attention. Fresh for 24 hours (src/lib/agent/summary.ts). `summaryStartedAt`
 * claims the regeneration, so two people opening a stale record don't both
 * pay for it.
 */
const summaryColumns = () => ({
  summary: text("summary"),
  summaryAt: timestamp("summary_at", { withTimezone: true }),
  summaryStartedAt: timestamp("summary_started_at", { withTimezone: true }),
});

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
  /** Agenda emails this teammate wants (Settings → Notifications). Off unless turned on. */
  emailDigests?: Partial<Record<EmailDigestKind, boolean>>;
  /** The phone number they last called or texted from, picked first next time. */
  phoneNumberId?: string;
  /** Teammates whose calendars they last had on in Calendar. */
  calendarPeople?: string[];
  /** Calendar's last view: the week or the month. */
  calendarView?: "week" | "month";
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
    /** Their own email signature, as sanitized HTML (`sanitizeSignatureHtml`). Added to email they send from their connected Outlook. */
    emailSignature: text("email_signature"),
    /** Whether the signature goes on every Outlook email to start with. They can still add or take it off each email. */
    signatureAuto: boolean("signature_auto").notNull().default(true),
    /** Deactivated teammates can't sign in, but everything they did stays attributed to them. */
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    /** When they last had the team chat open. Messages after it from others are their unread count. */
    chatReadAt: timestamp("chat_read_at", { withTimezone: true }),
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
  // window_start alone: the daily prune drops finished windows.
  (t) => [primaryKey({ columns: [t.key, t.windowStart] }), index("rate_limits_window_idx").on(t.windowStart)],
);

/**
 * Keys for the REST API and MCP. Only a SHA-256 hash of the key is stored;
 * the key itself is shown once, when it's made.
 * - `workspace` keys are made by admins for integrations. They act with full
 *   access, have no teammate behind them, and are refused by MCP.
 * - `personal` keys act as `userId`, with that teammate's current role, so
 *   an agent can never do more than its person can. Deactivating the
 *   teammate stops their keys at once.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    kind: text("kind").$type<ApiKeyKind>().notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    /** The first characters of the key, so people can tell keys apart without seeing them. */
    prefix: text("prefix").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    /** Updated at most once a minute, so busy keys don't write on every request. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Limits the key to reading, whatever its teammate's role allows. */
    readOnly: boolean("read_only").notNull().default(false),
    /** For connected apps: the OAuth client the teammate approved. */
    oauthClientId: text("oauth_client_id").references((): AnyPgColumn => oauthClients.id, { onDelete: "set null" }),
  },
  (t) => [uniqueIndex("api_keys_token_idx").on(t.tokenHash), index("api_keys_user_idx").on(t.userId)],
);

// ─── OAuth (agents connecting through MCP) ───────────────────────────────

/**
 * Apps that can ask a teammate for access over OAuth: registered by the app
 * itself (dynamic client registration), or described by a metadata document
 * at an https URL that is its client id. Registering grants nothing; a
 * teammate still has to approve the app.
 */
export const oauthClients = pgTable("oauth_clients", {
  /** The client_id: a random id for registered apps, the document URL for metadata-document apps. */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull().default([]),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method").$type<"none" | "client_secret_post" | "client_secret_basic">().notNull().default("none"),
  /** SHA-256 of the client secret, for apps that authenticate at the token endpoint. */
  secretHash: text("secret_hash"),
  clientUri: text("client_uri"),
  source: text("source").$type<"registered" | "metadata_document">().notNull(),
  /** Metadata-document apps: when the document was last read, so it's refreshed now and then. */
  metadataFetchedAt: timestamp("metadata_fetched_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/** Single-use authorization codes, bound to the app, the redirect URI and a PKCE challenge. Only a hash is stored. */
export const oauthCodes = pgTable("oauth_codes", {
  codeHash: text("code_hash").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthClients.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  readOnly: boolean("read_only").notNull().default(false),
  resource: text("resource"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  /** The grant the code was exchanged for, so a replayed code can revoke it. */
  grantId: uuid("grant_id").references(() => apiKeys.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
});

/** Access and refresh tokens for a connected app (an `api_keys` row of kind "oauth"). Only hashes are stored. */
export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    kind: text("kind").$type<"access" | "refresh">().notNull(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("oauth_tokens_grant_idx").on(t.grantId)],
);

/** One row: the workspace's name, defaults and the brand kit used by email. */
export const workspace = pgTable("workspace", {
  id: integer("id").primaryKey().default(1),
  name: text("name").notNull().default("My company"),
  currency: text("currency").notNull().default("USD"),
  timezone: text("timezone").notNull().default("America/Denver"),
  brand: jsonb("brand").$type<BrandKit>().notNull().default({}),
  email: jsonb("email").$type<EmailSettings>().notNull().default({}),
  phone: jsonb("phone").$type<PhoneSettings>().notNull().default({}),
  updatedAt: updatedAt(),
});

/**
 * Twilio pieces Settings → Phone numbers creates for browser calling: a TwiML
 * app that tells Twilio where to ask what a browser call should do, and, only
 * when the deployment has no API key of its own (the legacy auth-token
 * setup), an API key to sign call tokens (its secret encrypted,
 * src/lib/crypto.ts). TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET and
 * TWILIO_TWIML_APP_SID, when set, take precedence.
 */
export type PhoneSettings = {
  apiKeySid?: string;
  apiKeySecret?: string;
  twimlAppSid?: string;
  /** The origin the TwiML app and numbers point at, so Settings can tell when they need reconnecting. */
  webhookOrigin?: string;
};

/**
 * How the CRM hears about new mail. Set when an admin connects the Resend
 * webhook from Settings → Email domains. RESEND_WEBHOOK_SECRET, when set,
 * takes precedence over the stored secret.
 */
export type EmailSettings = {
  webhookId?: string;
  webhookEndpoint?: string;
  webhookSecret?: string;
  /** The events it was connected with, so Settings can tell when it needs reconnecting for newer ones (delivery reports). */
  webhookEvents?: string[];
};
/** What every email from the CRM is wrapped in. Everything is optional; blanks fall back to the workspace name and plain styling. */
export type BrandKit = {
  logoUrl?: string;
  /** Hex color for buttons and links in email only. */
  accentColor?: string;
  senderName?: string;
  /** Required by CAN-SPAM in marketing email. */
  postalAddress?: string;
  website?: string;
  /** Plain text signature appended to one-off emails, per sender name tokens {{sender_name}}, {{sender_title}}. */
  signature?: string;
};

// ─── Records ─────────────────────────────────────────────────────────────

/**
 * What each label means. A label is the lowercase string in a record's
 * `tags` (people, organizations, clients); this row gives it a description,
 * shown on hover and given to the agent, and says whether it shows in the
 * app. A label in use with no row here still works: it just has no
 * description yet (Settings → Labels lists those too).
 */
export const labels = pgTable("labels", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  description: text("description"),
  /** Hidden labels stay on their records and in the API, but the app doesn't show or offer them. */
  hidden: boolean("hidden").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    domain: text("domain"),
    phone: text("phone"),
    address: text("address"),
    industry: text("industry"),
    /**
     * Parent organizations group others under them (a franchisor and its
     * franchises). Only an organization marked `isParent` can be picked as
     * another's `parentId`, and a parent has no parent of its own, so the
     * grouping is one level deep (src/lib/crm/service/records.ts keeps it so).
     */
    /** Labels, like people's and clients' `tags`. Everyone at the organization carries them too (src/lib/crm/labels.ts). */
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    isParent: boolean("is_parent").notNull().default(false),
    parentId: uuid("parent_id").references((): AnyPgColumn => organizations.id, { onDelete: "set null" }),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    custom: jsonb("custom").$type<CustomValues>().notNull().default({}),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...summaryColumns(),
  },
  (t) => [
    index("organizations_name_idx").on(t.name),
    // Search (ILIKE '%q%') and the label filter.
    index("organizations_name_trgm_idx").using("gin", t.name.op("gin_trgm_ops")),
    index("organizations_domain_trgm_idx").using("gin", t.domain.op("gin_trgm_ops")),
    index("organizations_tags_idx").using("gin", t.tags),
    index("organizations_parent_idx").on(t.parentId),
    index("organizations_owner_idx").on(t.ownerId),
    index("organizations_phone_digits_idx").on(sql`right(regexp_replace(regexp_replace(${t.phone}, '\\s*(x|ext\\.?|extension|#)\\s*[0-9]+\\s*$', '', 'i'), '[^0-9]', '', 'g'), 10)`),
  ],
);

export const people = pgTable(
  "people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name"),
    email: text("email"),
    phone: text("phone"),
    /**
     * More addresses and numbers for the same person, besides `email` and
     * `phone` (which campaigns, texts and the composer use). Filled in when
     * duplicates are merged (scripts/dedupe.ts); mail, calls and texts from
     * any of them still land on this person.
     */
    otherEmails: jsonb("other_emails").$type<string[]>().notNull().default([]),
    otherPhones: jsonb("other_phones").$type<string[]>().notNull().default([]),
    title: text("title"),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    custom: jsonb("custom").$type<CustomValues>().notNull().default({}),
    /** Campaigns only go to people who haven't opted out. One-off emails from a record always send. */
    marketingOptIn: boolean("marketing_opt_in").notNull().default(true),
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    /**
     * Set when an email to this address bounced for good (Resend's webhook).
     * Campaigns skip the person until someone fixes the address, which clears it.
     */
    emailBouncedAt: timestamp("email_bounced_at", { withTimezone: true }),
    /**
     * When a campaign last went to them. Kept apart from `lastActivityAt`
     * (personal outreach: logged activity, one-off emails), so a newsletter
     * never makes someone look recently contacted.
     */
    lastCampaignAt: timestamp("last_campaign_at", { withTimezone: true }),
    /**
     * Starred at their organization: someone who decides (or signs off on)
     * buying. Shown as a star on the organization's people, and usable as an
     * audience filter. The label is a setting (`records.keyContactLabel`).
     */
    decisionMaker: boolean("decision_maker").notNull().default(false),
    /** When they agreed to receive marketing texts. Text campaigns need it unless `phone.textCampaignsNeedConsent` is off. */
    textConsentAt: timestamp("text_consent_at", { withTimezone: true }),
    /** When they replied STOP (or similar). Nothing is texted to them until they reply START. */
    textOptOutAt: timestamp("text_opt_out_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...summaryColumns(),
  },
  (t) => [
    index("people_org_idx").on(t.organizationId),
    index("people_owner_idx").on(t.ownerId),
    index("people_email_idx").on(t.email),
    index("people_name_idx").on(t.firstName, t.lastName),
    // The People table's default sort (peopleSorts.name in src/lib/crm/records.ts), then id.
    index("people_name_sort_idx").on(sql`lower(${t.firstName} || ' ' || coalesce(${t.lastName}, ''))`, t.id),
    // Search (ILIKE '%q%') on the full name and email, and the label filter.
    index("people_name_trgm_idx").using("gin", sql`(${t.firstName} || ' ' || coalesce(${t.lastName}, '')) gin_trgm_ops`),
    index("people_email_trgm_idx").using("gin", t.email.op("gin_trgm_ops")),
    index("people_tags_idx").using("gin", t.tags),
    // Calls and texts are matched on the last 10 digits, whatever way the number was typed (src/lib/phone/numbers.ts).
    index("people_phone_digits_idx").on(sql`right(regexp_replace(regexp_replace(${t.phone}, '\\s*(x|ext\\.?|extension|#)\\s*[0-9]+\\s*$', '', 'i'), '[^0-9]', '', 'g'), 10)`),
  ],
);

/**
 * Organizations a person is also at, besides their main one
 * (`people.organization_id`). Merging duplicates (scripts/dedupe.ts) keeps
 * every organization the duplicates were at here, so the person shows on
 * each organization's page.
 */
export const personOrganizations = pgTable(
  "person_organizations",
  {
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.personId, t.organizationId] }), index("person_organizations_org_idx").on(t.organizationId)],
);

/**
 * People on a client besides its contact (`clients.person_id`): added by hand
 * on the client's page. The client's People card shows the contact, these,
 * and everyone at its organization (`clientPeople` in src/lib/crm/records.ts).
 */
export const clientPeople = pgTable(
  "client_people",
  {
    clientId: uuid("client_id")
      .notNull()
      .references((): AnyPgColumn => clients.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.clientId, t.personId] }), index("client_people_person_idx").on(t.personId)],
);

/**
 * Organizations a client is also tied to besides its main one
 * (`clients.organization_id`): kept when clients from different organizations
 * are merged into one. Their people are the client's people, their clients'
 * pages list it, and their people's emails match its Stripe customers.
 */
export const clientOrganizations = pgTable(
  "client_organizations",
  {
    clientId: uuid("client_id")
      .notNull()
      .references((): AnyPgColumn => clients.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.clientId, t.organizationId] }), index("client_organizations_org_idx").on(t.organizationId)],
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
    /**
     * No longer read: customers are matched by email, and ones linked by hand
     * are in `client_stripe_links`. The column stays for now because a
     * deployment still running the previous version selects it, and
     * migrations run before that version is replaced.
     */
    stripeCustomerId: text("stripe_customer_id"),
    /**
     * What Stripe says about this client, rolled up from the subscriptions of
     * its matched customers by the Stripe sync (src/lib/stripe/sync.ts), so
     * lists can filter and sort on it. Null status: no customer in Stripe.
     */
    stripeStatus: text("stripe_status").$type<BillingStatus>(),
    /** Monthly amount of the subscriptions still running, in cents, after discounts. */
    stripeMrr: bigint("stripe_mrr", { mode: "number" }).notNull().default(0),
    /** What discounts take off those subscriptions a month: list price is `stripeMrr` plus this. */
    stripeDiscount: bigint("stripe_discount", { mode: "number" }).notNull().default(0),
    /** What they actually paid in the last 365 days, less refunds. */
    stripeCollected: bigint("stripe_collected", { mode: "number" }).notNull().default(0),
    /** Left to pay on invoices that were sent. */
    stripeOwed: bigint("stripe_owed", { mode: "number" }).notNull().default(0),
    /** Credit sitting on their Stripe customers, applied to their next invoices. */
    stripeCredit: bigint("stripe_credit", { mode: "number" }).notNull().default(0),
    /** Names of the Stripe products they're subscribed to now. */
    stripeProducts: jsonb("stripe_products").$type<string[]>().notNull().default([]),
    stripeSyncedAt: timestamp("stripe_synced_at", { withTimezone: true }),
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
    ...summaryColumns(),
  },
  (t) => [
    index("clients_stage_idx").on(t.stageId, t.rank),
    index("clients_pipeline_idx").on(t.pipelineId, t.category),
    index("clients_category_idx").on(t.category),
    index("clients_person_idx").on(t.personId),
    index("clients_org_idx").on(t.organizationId),
    index("clients_owner_idx").on(t.ownerId),
    index("clients_stripe_status_idx").on(t.stripeStatus),
    // Search (ILIKE '%q%') and the label filter.
    index("clients_name_trgm_idx").using("gin", t.name.op("gin_trgm_ops")),
    index("clients_tags_idx").using("gin", t.tags),
  ],
);

/**
 * A copy of every customer in the connected Stripe accounts, refreshed by the
 * daily sync. Clients match them by email: a customer belongs to a client
 * when its email is one of the client's people's (src/lib/stripe/sync.ts).
 */
export const stripeCustomers = pgTable(
  "stripe_customers",
  {
    /** Which connected account: the lowercased suffix of its STRIPE_SECRET_KEY variable. */
    account: text("account").notNull(),
    customerId: text("customer_id").notNull(),
    /** Lowercased, so it joins to people's emails. */
    email: text("email"),
    name: text("name"),
    balance: bigint("balance", { mode: "number" }).notNull().default(0),
    currency: text("currency"),
    delinquent: boolean("delinquent").notNull().default(false),
    /** What they actually paid, less refunds, in the last 30 days and the last 365, in cents. */
    collectedMonth: bigint("collected_month", { mode: "number" }).notNull().default(0),
    collectedYear: bigint("collected_year", { mode: "number" }).notNull().default(0),
    lastPaidAt: timestamp("last_paid_at", { withTimezone: true }),
    /** Left to pay on invoices that were sent, and how many of those are past due. */
    owed: bigint("owed", { mode: "number" }).notNull().default(0),
    overdue: integer("overdue").notNull().default(0),
    customerSince: timestamp("customer_since", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.account, t.customerId] }), index("stripe_customers_email_idx").on(t.email)],
);

/** One priced line of a Stripe subscription, as the sync stores it. */
export type StripeItem = { product: string; name: string; amount: number | null; quantity: number; interval: string | null; intervalCount: number | null };

/** A copy of every subscription in the connected Stripe accounts, canceled ones included, refreshed by the daily sync. */
export const stripeSubscriptions = pgTable(
  "stripe_subscriptions",
  {
    account: text("account").notNull(),
    subscriptionId: text("subscription_id").notNull(),
    customerId: text("customer_id").notNull(),
    status: text("status").notNull(),
    currency: text("currency").notNull().default("usd"),
    /** Its price lines as a monthly amount, in cents, at list price. */
    monthly: bigint("monthly", { mode: "number" }).notNull().default(0),
    /** The monthly amount after discounts: what they're actually billed, going by the latest invoice. */
    net: bigint("net", { mode: "number" }).notNull().default(0),
    items: jsonb("items").$type<StripeItem[]>().notNull().default([]),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.account, t.subscriptionId] }), index("stripe_subscriptions_customer_idx").on(t.account, t.customerId)],
);

/**
 * Every invoice and payment in the connected Stripe accounts, for the Billing
 * page's activity table. The daily sync copies the last year each run (all
 * of history the first time an account is seen) and keeps older rows, so the
 * history only grows. Matched to clients through their customers, like
 * subscriptions. Rules in src/lib/stripe/activity.ts.
 */
export const stripeActivity = pgTable(
  "stripe_activity",
  {
    account: text("account").notNull(),
    /** in_… for an invoice, ch_… for a payment. */
    id: text("id").notNull(),
    kind: text("kind").$type<"invoice" | "payment">().notNull(),
    /** Null for a payment taken without a customer. */
    customerId: text("customer_id"),
    /** Stripe's status, as it has it. */
    status: text("status").notNull(),
    /** An invoice's total or what a payment charged, in cents. */
    amount: bigint("amount", { mode: "number" }).notNull().default(0),
    refunded: bigint("refunded", { mode: "number" }).notNull().default(0),
    /** Left to pay on an open invoice. */
    remaining: bigint("remaining", { mode: "number" }).notNull().default(0),
    currency: text("currency").notNull().default("usd"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    number: text("number"),
    description: text("description"),
    method: text("method"),
    failure: text("failure"),
    url: text("url"),
    pdf: text("pdf"),
    invoiceId: text("invoice_id"),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.account, t.id] }), index("stripe_activity_created_idx").on(t.createdAt), index("stripe_activity_customer_idx").on(t.account, t.customerId)],
);

/**
 * Corrections to the email matching, made on a client's page: a customer
 * linked by hand (`linked`, for one whose email isn't on any of the client's
 * people) or a match that isn't theirs (`hidden`).
 */
export const clientStripeLinks = pgTable(
  "client_stripe_links",
  {
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    account: text("account").notNull(),
    customerId: text("customer_id").notNull(),
    kind: text("kind").$type<"linked" | "hidden">().notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.clientId, t.account, t.customerId] })],
);

/**
 * What each Stripe product means to the team ("ThirdPool Advanced": the
 * benchmarks we deliver on it), keyed by the product's name as Stripe has it.
 * Set in Settings → Services; shown wherever the product shows, and read by
 * the agent. Matched without regard to case.
 */
export const productDescriptions = pgTable(
  "product_descriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("product_descriptions_name_idx").on(sql`lower(${t.name})`)],
);

/**
 * Retired: services tracked by hand, replaced by what Stripe reports
 * (`clients.stripe_products`, described by `product_descriptions`). Nothing
 * reads or writes these three tables any more; they're kept so the data
 * isn't lost until a migration drops them.
 *
 * What the workspace sold. Clients were linked to the ones they used.
 */
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
 * The levels a service is sold at ("Starter", "Advanced"), each with its own
 * usual price, billing and description. Managed under each service in
 * Settings → Services. A service with no plans is sold at its own price.
 */
export const servicePlans = pgTable(
  "service_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** What the plan includes. Offered as the note when the plan is added to a client. */
    description: text("description"),
    /** The usual price, in cents. Each client's subscription can differ. */
    price: bigint("price", { mode: "number" }).notNull().default(0),
    interval: text("interval").$type<BillingInterval>().notNull().default("month"),
    position: integer("position").notNull().default(0),
    /** Archived plans can't be picked for clients, but stay on the ones that have them. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("service_plans_service_idx").on(t.serviceId)],
);

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
    /** The plan of that service they're on, when the service has plans. */
    planId: uuid("plan_id").references(() => servicePlans.id),
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
    /** The API key it was logged through, if any. With no `userId`, a workspace key logged it. */
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    /** Who it's assigned to (tasks, planned calls). Defaults to the author. */
    assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    /** Set when the activity is an email the CRM sent. */
    emailId: uuid("email_id").references((): AnyPgColumn => outboundEmails.id, { onDelete: "set null" }),
    /** Set when the activity is a message in a connected inbox, so the timeline can open the conversation. */
    inboxThreadId: uuid("inbox_thread_id").references((): AnyPgColumn => inboxThreads.id, { onDelete: "set null" }),
    /** Set when the activity is mail synced from a teammate's connected mailbox (Microsoft 365). */
    syncedEmailId: uuid("synced_email_id").references((): AnyPgColumn => syncedEmails.id, { onDelete: "set null" }),
    /** Set when the activity is a call made or received through the CRM's phone numbers (Twilio). */
    callId: uuid("call_id").references((): AnyPgColumn => phoneCalls.id, { onDelete: "set null" }),
    /** Set when the activity is a text sent or received through the CRM's phone numbers. */
    textMessageId: uuid("text_message_id").references((): AnyPgColumn => textMessages.id, { onDelete: "set null" }),
    /** The agent's latest background run for this note (it was mentioned) or task (it was assigned). */
    agentRunId: uuid("agent_run_id").references((): AnyPgColumn => agentRuns.id, { onDelete: "set null" }),
    /** A planned meeting copied to the assignee's Outlook calendar: the event there, and the account it's in. */
    calendarEventId: text("calendar_event_id"),
    calendarAccountId: uuid("calendar_account_id").references((): AnyPgColumn => connectedAccounts.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    // Set on every update through Drizzle, so "what changed lately" (src/lib/live.ts) sees edits that don't set it by hand.
    updatedAt: updatedAt().$onUpdate(() => new Date()),
  },
  (t) => [
    index("activities_person_idx").on(t.personId, t.createdAt),
    index("activities_org_idx").on(t.organizationId, t.createdAt),
    index("activities_client_idx").on(t.clientId, t.createdAt),
    index("activities_assignee_due_idx").on(t.assigneeId, t.completedAt, t.dueAt),
    index("activities_call_idx").on(t.callId),
    index("activities_text_idx").on(t.textMessageId),
    // The newest activity change, for the open-page refresh check (src/lib/live.ts).
    index("activities_updated_idx").on(t.updatedAt),
    // The home feed's order (teamFeed in src/lib/crm/activities.ts): keep the expression and predicate in step with it.
    index("activities_feed_idx")
      .on(sql`coalesce(${t.occurredAt}, ${t.completedAt}, ${t.createdAt}) desc`)
      .where(sql`${t.completedAt} is not null or ${t.dueAt} is null`),
    // Planned work per record: the next step (nextActivity in src/lib/crm/records.ts) and "no next step" on the home page.
    index("activities_client_planned_idx").on(t.clientId, t.dueAt).where(sql`${t.completedAt} is null and ${t.dueAt} is not null`),
    index("activities_person_planned_idx").on(t.personId, t.dueAt).where(sql`${t.completedAt} is null and ${t.dueAt} is not null`),
    index("activities_org_planned_idx").on(t.organizationId, t.dueAt).where(sql`${t.completedAt} is null and ${t.dueAt} is not null`),
    // Foreign keys: lookups from the other side, and deletes that set them null.
    index("activities_email_idx").on(t.emailId),
    index("activities_inbox_thread_idx").on(t.inboxThreadId),
    index("activities_synced_email_idx").on(t.syncedEmailId),
    index("activities_agent_run_idx").on(t.agentRunId),
  ],
);

/**
 * Everyone else on an activity besides `activities.person_id`: the other
 * attendees of a meeting, the other recipients (To and Cc) of an email. The
 * activity shows on each of their timelines too.
 */
export const activityPeople = pgTable(
  "activity_people",
  {
    activityId: uuid("activity_id")
      .notNull()
      .references(() => activities.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.activityId, t.personId] }), index("activity_people_person_idx").on(t.personId)],
);

/**
 * Replies under a note, oldest first: a teammate answering a note they were
 * mentioned in, or the agent answering one that called on it. They live on
 * the note rather than as activities of their own, so a thread is one entry
 * on the timeline and in every list (src/lib/crm/service/activities.ts).
 */
export const noteReplies = pgTable(
  "note_replies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    activityId: uuid("activity_id")
      .notNull()
      .references(() => activities.id, { onDelete: "cascade" }),
    /** Sanitized rich-text HTML, like a note's body. */
    body: text("body").notNull(),
    /** Who wrote it, and the key it came through (the agent's, for its answers). */
    userId: uuid("user_id").references(() => users.id),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("note_replies_activity_idx").on(t.activityId, t.createdAt)],
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
    /** The API key the change came through, if any (a workspace key when `userId` is null). */
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  // events_created_idx: the newest change, which open pages check to know when to refresh (src/lib/live.ts).
  (t) => [index("events_entity_idx").on(t.entityType, t.entityId, t.createdAt), index("events_created_idx").on(t.createdAt)],
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
    /** The note, call or meeting it was attached to. Deleting the activity keeps the file on the record. */
    activityId: uuid("activity_id").references(() => activities.id, { onDelete: "set null" }),
    /** The folder it's in on the Files page. Null is the top level. */
    folderId: uuid("folder_id").references((): AnyPgColumn => fileFolders.id, { onDelete: "set null" }),
    /** Where it was uploaded: "chat" for a team chat attachment, null for everything else. */
    origin: text("origin").$type<"chat">(),
    /** The team chat message it was posted with. */
    chatMessageId: uuid("chat_message_id").references((): AnyPgColumn => chatMessages.id, { onDelete: "set null" }),
    /** Set while the file is public: anyone with /share/<token> can open it. Making it internal again clears it, so old links stop working. */
    publicToken: text("public_token"),
    publicAt: timestamp("public_at", { withTimezone: true }),
    /**
     * A short description of what's in the file, written by a small model when
     * it's uploaded (src/lib/files/describe.ts) or by a teammate
     * (`description_by`). The agent finds files by it.
     */
    description: text("description"),
    /** The facts, figures and terms the file holds, as plain text, so the agent can answer from it without opening it. Written with the description. */
    contentNotes: text("content_notes"),
    /** The teammate who last wrote the description by hand; null when the model wrote it. A hand-written one is never overwritten. */
    descriptionBy: uuid("description_by").references(() => users.id),
    /** "done", "skipped" (a kind of file the model can't read) or "failed". Null until it's been looked at. */
    describeStatus: text("describe_status").$type<"done" | "skipped" | "failed">(),
    describedAt: timestamp("described_at", { withTimezone: true }),
    /** Claims the description while it's being written, so two requests don't both pay for it. */
    describeStartedAt: timestamp("describe_started_at", { withTimezone: true }),
    /**
     * The meaning of the file's name, description and key facts as a vector
     * (`agent.embeddingModel`, FILE_EMBEDDING_DIMENSIONS wide), so the agent and
     * the API find files by what a question means, not just its words. Rewritten
     * whenever the description changes; null when there's none.
     */
    embedding: vector("embedding", { dimensions: 1536 }),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("files_person_idx").on(t.personId),
    index("files_org_idx").on(t.organizationId),
    index("files_client_idx").on(t.clientId),
    index("files_activity_idx").on(t.activityId),
    index("files_folder_idx").on(t.folderId),
    index("files_chat_message_idx").on(t.chatMessageId),
    uniqueIndex("files_public_token_idx").on(t.publicToken),
    /** One row per stored file, so removing a row can never delete bytes another row still uses. */
    uniqueIndex("files_url_idx").on(t.url),
    index("files_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

/**
 * Records a file was attached to after it was uploaded, besides the ones it
 * was uploaded on (`files.person_id` and the rest). One record per row.
 */
export const fileLinks = pgTable(
  "file_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileId: uuid("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    personId: uuid("person_id").references(() => people.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("file_links_person_idx").on(t.personId, t.fileId),
    uniqueIndex("file_links_org_idx").on(t.organizationId, t.fileId),
    uniqueIndex("file_links_client_idx").on(t.clientId, t.fileId),
    index("file_links_file_idx").on(t.fileId),
  ],
);

/** Folders on the Files page. Nested to any depth; a folder with no parent is at the top level. */
export const fileFolders = pgTable(
  "file_folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    parentId: uuid("parent_id").references((): AnyPgColumn => fileFolders.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("file_folders_parent_idx").on(t.parentId)],
);

/**
 * The team chat: one thread for everyone who can sign in. `body` is plain
 * text; "@Name" mentions are worked out from it (src/lib/crm/mentions.ts).
 * Attachments are `files` rows pointing back here (`files.chat_message_id`).
 */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    /** Teammates it mentions, as worked out when it was posted or last edited. */
    mentions: uuid("mentions").array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** Moves on every post, edit and delete, so open pages notice (src/lib/live.ts). */
    updatedAt: updatedAt().$onUpdate(() => new Date()),
  },
  (t) => [index("chat_messages_created_idx").on(t.createdAt), index("chat_messages_updated_idx").on(t.updatedAt)],
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

/** A file sent with an email. The bytes stay in `files`; this is what the email showed. */
export type EmailAttachment = { fileId: string; name: string; size: number; contentType: string };

/** Reusable emails. `body` is rich-text HTML with merge tags; the brand kit wraps it when sent. */
export const emailTemplates = pgTable("email_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  subject: text("subject").notNull().default(""),
  body: text("body").notNull().default(""),
  /** Files that come along when the template is used. */
  attachments: jsonb("attachments").$type<EmailAttachment[]>().notNull().default([]),
  /** Shared templates show for everyone; personal ones only for their author. */
  shared: boolean("shared").notNull().default(true),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Who a campaign goes to. Evaluated at send time, so people added later are included. */
export type CampaignAudience = {
  tags?: string[];
  /** Whether people need any of `tags` (the default) or all of them. */
  tagMatch?: "any" | "all";
  /** Leave out people with any of these tags. */
  excludeTags?: string[];
  /** People with something logged in the last N days. */
  activeWithinDays?: number;
  /** People with no personal contact logged in the last N days (or ever). Campaigns don't count. */
  inactiveForDays?: number;
  /** People who haven't had a campaign in the last N days (or ever). */
  noCampaignForDays?: number;
  /** Person custom fields: the field's value is one of `values` (a checkbox field uses "true" / "false"). */
  customFields?: { key: string; values: string[] }[];
  /** People connected to a client in one of these pipelines. */
  pipelineIds?: string[];
  ownerIds?: string[];
  /** People at one of these organizations, or at an organization that is part of one (its parent organization). */
  organizationIds?: string[];
  /** People connected to a client in one of these categories (the client's contact, or anyone at its organization). */
  clientCategories?: ClientCategory[];
  /** …in one of these stages. */
  stageIds?: string[];
  /** …with one of these client tags. */
  clientTags?: string[];
  /** …subscribed in Stripe to one of these products now, by name (matched without regard to case). */
  stripeProducts?: string[];
  /**
   * Retired: services tracked by hand, before Stripe drove them. Still
   * applied to audiences saved with it, so they don't quietly widen; the
   * filters only offer taking it off.
   */
  serviceIds?: string[];
  /** …past clients who left for one of these reasons. */
  churnReasons?: string[];
  /** Leave out past clients marked as not open to coming back. */
  openToReturnOnly?: boolean;
  /** Only people starred as decision makers at their organization. */
  decisionMakersOnly?: boolean;
  /** People at organizations in one of these industries. */
  organizationIndustries?: string[];
  /** Organization custom fields of the person's organization, matched like `customFields`. */
  organizationFields?: { key: string; values: string[] }[];
  /** A fixed list instead of filters. */
  personIds?: string[];
};

/**
 * A saved audience: a named set of filters, reused by campaigns. Campaigns
 * that use one follow its filters as they are when the campaign sends.
 */
export const audiences = pgTable("audiences", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  filters: jsonb("filters").$type<CampaignAudience>().notNull().default({}),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

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
    /** A saved audience. When set, its filters are used instead of `audience`. */
    audienceId: uuid("audience_id").references(() => audiences.id, { onDelete: "set null" }),
    /** Where replies go. Starts as the email of whoever set the campaign up; blank falls back to the creator's email at send time. */
    replyTo: text("reply_to"),
    /** Sent with every email. Campaigns with attachments go out one at a time: Resend's batch endpoint can't carry files. */
    attachments: jsonb("attachments").$type<EmailAttachment[]>().notNull().default([]),
    /** Email (through Resend) or text (through Twilio, from `phoneNumberId`). Fixed when the campaign is created. */
    channel: text("channel").$type<CampaignChannel>().notNull().default("email"),
    /** Text campaigns: the message, plain text with merge tags. */
    textBody: text("text_body").notNull().default(""),
    phoneNumberId: uuid("phone_number_id").references((): AnyPgColumn => phoneNumbers.id, { onDelete: "set null" }),
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

/** Where a sent email got to, from Resend's delivery reports. Only ever moves forward (src/lib/email/delivery.ts). */
export type DeliveryStatus = "sent" | "delayed" | "delivered" | "failed" | "suppressed" | "bounced" | "complained";

/** Every email the CRM sent: one-off emails from a record and each campaign recipient. */
export const outboundEmails = pgTable(
  "outbound_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    /** The client it was sent from, or (for a campaign) the matching client it was sent because of. */
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    to: text("to").notNull(),
    cc: text("cc"),
    replyTo: text("reply_to"),
    subject: text("subject").notNull(),
    attachments: jsonb("attachments").$type<EmailAttachment[]>().notNull().default([]),
    resendId: text("resend_id"),
    /** How it went out: Resend (the CRM's address or an inbox), or the teammate's own Microsoft 365 mailbox. */
    provider: text("provider").$type<"resend" | "microsoft">().notNull().default("resend"),
    /** Sent through Microsoft: the Internet Message-ID, so the mailbox sync recognizes it in Sent Items. */
    messageId: text("message_id"),
    /** Null until Resend's first report. */
    deliveryStatus: text("delivery_status").$type<DeliveryStatus>(),
    deliveryStatusAt: timestamp("delivery_status_at", { withTimezone: true }),
    /** Why it bounced, failed or was suppressed, in Resend's words. */
    deliveryDetail: text("delivery_detail"),
    /** Opens and clicks: filled in only when `email.trackOpens` / `email.trackClicks` are on in app.config.ts. */
    firstOpenedAt: timestamp("first_opened_at", { withTimezone: true }),
    openCount: integer("open_count").notNull().default(0),
    firstClickedAt: timestamp("first_clicked_at", { withTimezone: true }),
    clickCount: integer("click_count").notNull().default(0),
    /** When the hourly check last asked Resend about an email with no final report. */
    statusCheckedAt: timestamp("status_checked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("outbound_emails_person_idx").on(t.personId),
    index("outbound_emails_resend_idx").on(t.resendId),
    index("outbound_emails_campaign_status_idx").on(t.campaignId, t.deliveryStatus),
    uniqueIndex("outbound_emails_campaign_person_idx").on(t.campaignId, t.personId),
    index("outbound_emails_message_idx").on(t.messageId),
    // Emails still waiting on a final delivery report (reconcileDeliveryStatuses in src/lib/email/delivery.ts).
    index("outbound_emails_awaiting_idx")
      .on(t.createdAt)
      .where(sql`${t.resendId} is not null and (${t.deliveryStatus} is null or ${t.deliveryStatus} in ('sent', 'delayed'))`),
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
    // The newest change to a conversation, for the open-page refresh check (src/lib/live.ts).
    index("inbox_threads_updated_idx").on(t.updatedAt),
    // The sidebar's unread count (src/lib/sidebar-counts.ts): unread inbox threads by recency.
    index("inbox_threads_unread_idx").on(t.folder, t.lastMessageAt).where(sql`not ${t.read}`),
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
    /** Deleted from the records: hidden from the conversation too, and never put back on a timeline by a later sync. */
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("inbox_messages_resend_idx").on(t.resendEmailId),
    index("inbox_messages_thread_idx").on(t.threadId, t.sentAt),
    // Timelines read each email activity's sender and recipients from here.
    index("inbox_messages_activity_idx").on(t.activityId),
  ],
);

/**
 * Who sent each email from the inbox page (a reply or a new email), by
 * Resend's id. The send and Resend's webhook race to sync the message; the
 * sync credits the sender from here whichever wins, so every email the team
 * sends says who sent it.
 */
export const inboxSends = pgTable("inbox_sends", {
  resendEmailId: text("resend_email_id").primaryKey(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

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

// ─── AI agent ────────────────────────────────────────────────────────

/**
 * One message of an agent conversation, in the AI SDK's UI message shape
 * (`UIMessage` from "ai"): text, tool calls with their input and output, and
 * approvals. Kept loose here so the schema doesn't depend on the SDK.
 */
export type AgentMessage = { id: string; role: "system" | "user" | "assistant"; parts: Record<string, unknown>[]; metadata?: Record<string, unknown> };

/**
 * A teammate's conversations with the in-app agent. Private to them: only
 * `userId` can list, read or continue a thread. The agent acts with that
 * teammate's role, and the changes it makes are attributed to them in history
 * like any other.
 */
export const agentThreads = pgTable(
  "agent_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New chat"),
    /** Named by the teammate: automatic titles leave it alone. */
    titleByHand: boolean("title_by_hand").notNull().default(false),
    messages: jsonb("messages").$type<AgentMessage[]>().notNull().default([]),
    /** When the teammate last wrote in it; the thread list is ordered by this. */
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("agent_threads_user_idx").on(t.userId, t.lastMessageAt)],
);

/**
 * Work the agent does in the background for a teammate (docs/AGENT.md):
 * started from chat, by mentioning it in a note, by assigning it a task, or as
 * one record of a bulk request. Each run is one eve session (agent/) acting as
 * `userId`, with their role, and every change it makes is theirs "via Agent".
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Who asked. The run has their access and its changes are attributed to them. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").$type<AgentRunSource>().notNull(),
    title: text("title").notNull(),
    /** What the teammate asked for, in their words. */
    prompt: text("prompt").notNull(),
    status: text("status").$type<AgentRunStatus>().notNull().default("queued"),
    /** The eve session doing the work, once it has started. */
    sessionId: text("session_id"),
    /** The chat the request came from; the answer is posted back into it. */
    threadId: uuid("thread_id").references(() => agentThreads.id, { onDelete: "set null" }),
    /** The note that mentioned the agent, or the task assigned to it. */
    activityId: uuid("activity_id").references((): AnyPgColumn => activities.id, { onDelete: "set null" }),
    /** The record the request is about, when there is one. */
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    /** Runs started together by one bulk request share this. */
    batchId: uuid("batch_id"),
    /** The scheduled job that started it, when one did. */
    scheduleId: uuid("schedule_id").references((): AnyPgColumn => agentSchedules.id, { onDelete: "set null" }),
    /** The agent's answer (markdown), or what went wrong, in a sentence. */
    result: text("result"),
    error: text("error"),
    /** Model spend so far, in millionths of a US dollar, as AI Gateway reported it. */
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" }).notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /**
     * When the agent panel stops listing it under Background tasks: set a while ahead the first time
     * the teammate's open panel lists it finished, or to now when they clear it. The run itself stays
     * (history, the budget, the API).
     */
    hideAt: timestamp("hide_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt().$onUpdate(() => new Date()),
  },
  (t) => [
    index("agent_runs_user_idx").on(t.userId, t.createdAt),
    index("agent_runs_status_idx").on(t.status, t.createdAt),
    index("agent_runs_batch_idx").on(t.batchId),
    index("agent_runs_activity_idx").on(t.activityId),
    // The month's spend, for the budget check.
    index("agent_runs_created_idx").on(t.createdAt),
  ],
);

/**
 * Email a teammate sent to the agent's address (docs/AGENT.md#email-forwarding):
 * what came in, whether it was accepted, the run it started and the reply sent back.
 * Private to that teammate (Settings → Agent). Mail that doesn't claim to be from a
 * teammate isn't stored. Rounds of one back-and-forth share a
 * `conversationId` (the first email's id) and the first email's `conversationKey`,
 * which is in the reply address.
 */
export const emailForwards = pgTable(
  "email_forwards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Resend's id for the received email. Unique, so a repeated webhook does nothing. */
    resendEmailId: text("resend_email_id").notNull(),
    /** The teammate it's from (claimed, until the checks prove it; `status` says whether they did). */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id"),
    conversationKey: text("conversation_key"),
    round: integer("round").notNull().default(1),
    /** The email's own Message-ID: a reply that quotes it finds the conversation, and the same email is never read twice. */
    messageId: text("message_id"),
    fromAddress: text("from_address"),
    subject: text("subject"),
    /** What the agent read (cleared after 30 days; the record notes it wrote stay). */
    text: text("text"),
    /** received → working → answered, or refused / failed with `reason`. */
    status: text("status").$type<EmailForwardStatus>().notNull().default("received"),
    /** Why it was refused or didn't finish, in a sentence. */
    reason: text("reason"),
    /** How the sender was verified (which DKIM signature or receiver). */
    verifiedBy: text("verified_by"),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    /** Resend's id for the reply the CRM sent back. */
    replyId: text("reply_id"),
    repliedAt: timestamp("replied_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("email_forwards_resend_idx").on(t.resendEmailId),
    index("email_forwards_user_idx").on(t.userId, t.createdAt),
    index("email_forwards_run_idx").on(t.runId),
    index("email_forwards_conversation_idx").on(t.conversationId),
    index("email_forwards_key_idx").on(t.conversationKey),
    // The same email sent again (by anyone who received it) is read once. Only verified rows hold a slot,
    // so a forged copy with the same Message-ID can't take the real one's place.
    uniqueIndex("email_forwards_message_idx").on(t.userId, t.messageId).where(sql`${t.verifiedBy} is not null`),
  ],
);

/**
 * An email or text the agent wrote for a teammate to review and send
 * (docs/AGENT.md). The agent never sends anything itself: a draft waits
 * on the person's page until `userId` opens it in the composer and sends it,
 * or discards it.
 */
export const agentDrafts = pgTable(
  "agent_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Whose draft it is: the teammate the agent was working for. Only they see it and can send it. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The background run that wrote it, when one did (a chat can draft too). */
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    kind: text("kind").$type<AgentDraftKind>().notNull(),
    /** Who it's to. */
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    /** Emails only. */
    subject: text("subject"),
    /** Sanitized HTML for an email; plain text for a text message. */
    body: text("body").notNull(),
    /** CRM files to send with an email, as the composer attaches them. The teammate can drop any before sending. */
    attachments: jsonb("attachments").$type<EmailAttachment[]>().notNull().default([]),
    status: text("status").$type<AgentDraftStatus>().notNull().default("pending"),
    createdAt: createdAt(),
    /** When it was sent or discarded. */
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [index("agent_drafts_user_idx").on(t.userId, t.status, t.createdAt), index("agent_drafts_person_idx").on(t.personId, t.status)],
);

/**
 * Skills: instructions a teammate or an admin saved for the agent, such as
 * how to write up a call or what a good prospect looks like (docs/AGENT.md).
 * A personal skill is used only by its teammate's agent. A workspace skill is
 * shared by an admin and used by everyone's. `mode` says whether it's part of
 * every conversation or read when the work calls for it.
 */
export const agentSkills = pgTable(
  "agent_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").$type<AgentScope>().notNull().default("personal"),
    /** Whose it is (personal), or who wrote it (workspace). */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** When to use it, in a sentence: what the agent matches a request against. */
    description: text("description").notNull(),
    /** What to do, in markdown. */
    instructions: text("instructions").notNull(),
    mode: text("mode").$type<AgentSkillMode>().notNull().default("on_demand"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt().$onUpdate(() => new Date()),
  },
  (t) => [index("agent_skills_scope_idx").on(t.scope, t.userId)],
);

/**
 * Scheduled jobs: work the agent does on its own, on a cadence
 * (docs/AGENT.md). A personal job runs as its teammate: the agent cron starts
 * a background run for them when `nextRunAt` passes. A workspace job is an
 * offer from an admin: it never runs itself, and a teammate who adds it gets
 * their own copy (`fromId`), which runs as them.
 */
export const agentSchedules = pgTable(
  "agent_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").$type<AgentScope>().notNull().default("personal"),
    /** Who it runs as (personal), or who offered it (workspace). */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** What to do each time, in plain words: the run's request. */
    prompt: text("prompt").notNull(),
    every: text("every").$type<ScheduleEvery>().notNull(),
    /** "HH:MM" in the workspace's time zone, on the quarter hour. */
    time: text("time").notNull(),
    /** 1 (Monday) to 7 (Sunday), for weekly jobs. */
    weekday: integer("weekday"),
    /** 1 to 28, for monthly jobs. */
    monthDay: integer("month_day"),
    /** YYYY-MM-DD, for a job that runs once. */
    onDate: text("on_date"),
    enabled: boolean("enabled").notNull().default(true),
    /** When it runs next. Null for an offer, a paused job, or a one-time job that has run. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastRunId: uuid("last_run_id").references((): AnyPgColumn => agentRuns.id, { onDelete: "set null" }),
    /** Why the last run couldn't start (the month's budget is spent, say), in a sentence. */
    lastError: text("last_error"),
    /** The shared job this one was added from. */
    fromId: uuid("from_id").references((): AnyPgColumn => agentSchedules.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt().$onUpdate(() => new Date()),
  },
  (t) => [index("agent_schedules_due_idx").on(t.nextRunAt), index("agent_schedules_user_idx").on(t.scope, t.userId)],
);

// ─── Push notifications ──────────────────────────────────────────────────

/**
 * A browser or installed app that receives push notifications for a teammate
 * (Web Push, RFC 8030). One row per device. `alerts` is what this device
 * wants, so a phone can get replies while the laptop only gets tasks.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The push service URL. Unique: subscribing the same browser again updates its row. */
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    /** "Chrome on macOS", from the user agent, so people can tell their devices apart. */
    label: text("label").notNull(),
    alerts: jsonb("alerts").$type<NotificationKind[]>().notNull().default([]),
    createdAt: createdAt(),
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    /** Failed sends in a row. A device the push service says is gone is deleted at once. */
    failures: integer("failures").notNull().default(0),
  },
  (t) => [uniqueIndex("push_subscriptions_endpoint_idx").on(t.endpoint), index("push_subscriptions_user_idx").on(t.userId)],
);

/**
 * Every notification sent, push or agenda email, one row per teammate.
 * `dedupeKey` makes sending idempotent: the cron and a retried webhook can
 * both try, only one sends.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** A push alert, a push test, or an agenda email (`daily_email`, `weekly_email`), which uses the same dedupe key to go out once. */
    kind: text("kind").$type<NotificationKind | "test" | `${EmailDigestKind}_email`>().notNull(),
    title: text("title").notNull(),
    body: text("body"),
    /** Where tapping it goes, a path on this site. */
    url: text("url").notNull().default("/"),
    dedupeKey: text("dedupe_key"),
    /** Devices it reached. */
    delivered: integer("delivered").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("notifications_dedupe_idx").on(t.userId, t.dedupeKey), index("notifications_user_idx").on(t.userId, t.createdAt)],
);

// ─── Connected accounts (Microsoft 365) ──────────────────────────────────

/**
 * A teammate's own mailbox and calendar, connected over OAuth (Settings →
 * Email and calendar). Tokens are encrypted at rest (src/lib/crypto.ts). One
 * per teammate per provider. Each part can be switched off on its own.
 */
export const connectedAccounts = pgTable(
  "connected_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").$type<"microsoft">().notNull(),
    /** The account's id at the provider (Microsoft's object id), so reconnecting another mailbox is noticed. */
    externalId: text("external_id").notNull(),
    email: text("email").notNull(),
    name: text("name"),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    /** Send email from records through this mailbox instead of the CRM's address. */
    sendMail: boolean("send_mail").notNull().default(true),
    /** Copy mail to and from contacts onto their records. */
    syncMail: boolean("sync_mail").notNull().default(true),
    /** Put meetings assigned to them in this calendar, and show it in Calendar. */
    syncCalendar: boolean("sync_calendar").notNull().default(true),
    /** What teammates see of this calendar in Calendar. */
    calendarSharing: text("calendar_sharing").$type<CalendarSharing>().notNull().default("busy"),
    /** The newest message already looked at, per folder, so each sync only reads what's new. */
    /**
     * Where each synced folder was read up to, by folder: the newest message's
     * time for Inbox and Sent Items (`inbox`, `sent`), Graph's delta link for a
     * folder the teammate picked (by its id).
     */
    mailCursor: jsonb("mail_cursor").$type<Record<string, string>>().notNull().default({}),
    /** The folders to sync instead of Inbox and Sent Items, when the teammate picked their own. Null: the default two. */
    mailFolders: jsonb("mail_folders").$type<{ id: string; name: string }[]>(),
    /** Addresses and domains whose mail is never synced from this mailbox, lowercased ("jo@acme.com", "acme.com"). */
    blocked: jsonb("blocked").$type<string[]>().notNull().default([]),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    /** The last thing that went wrong, in words, cleared by the next good sync. */
    lastError: text("last_error"),
    /** `reconnect`: the provider refused the refresh token (password changed, access revoked). */
    status: text("status").$type<"active" | "reconnect">().notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("connected_accounts_user_idx").on(t.userId, t.provider)],
);

/**
 * Every message the mailbox sync looked at, so it never copies one twice.
 * `imported` ones became an email activity. `withheld` ones looked private or
 * confidential (Outlook's sensitivity label, or the decision model's screen):
 * nothing of their content is kept, only that they were skipped and why.
 */
export const syncedEmails = pgTable(
  "synced_emails",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The mailbox it came from. Kept (as null) after the teammate disconnects, so copied mail still says who it was from. */
    accountId: uuid("account_id").references(() => connectedAccounts.id, { onDelete: "set null" }),
    /** The message's id in the mailbox. */
    externalId: text("external_id").notNull(),
    /** The Internet Message-ID, shared by every copy of the message, so two teammates on one thread don't log it twice. */
    internetMessageId: text("internet_message_id"),
    conversationId: text("conversation_id"),
    direction: text("direction").$type<"inbound" | "outbound">().notNull(),
    from: text("from"),
    to: jsonb("to").$type<string[]>().notNull().default([]),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    /**
     * `imported`: on the records for the team (its activity points here).
     * `private`: kept here, shown only to the mailbox's teammate, with its
     * subject and body below. `withheld`: looked at and kept out; no content.
     */
    status: text("status").$type<"imported" | "private" | "withheld">().notNull(),
    /** Only while `private`: the email itself, since it has no activity. Cleared when it's shared, removed or the mailbox disconnects. */
    subject: text("subject"),
    body: text("body"),
    /** Why it was kept out, or that it went in unscreened, in words. */
    reason: text("reason"),
    /** The screen's probability that it's sensitive (0–1), for tuning `microsoft.screenThreshold`. Null when it wasn't screened. */
    screenScore: doublePrecision("screen_score"),
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("synced_emails_account_msg_idx").on(t.accountId, t.externalId),
    index("synced_emails_internet_idx").on(t.internetMessageId),
    index("synced_emails_status_idx").on(t.accountId, t.status),
  ],
);

// ─── Phone (Twilio) ──────────────────────────────────────────────────────

/**
 * A Twilio number the team calls and texts from (Settings → Phone numbers).
 * Calls to it ring `forwardTo` (a cell phone); `forwardUserId` gets the task
 * to write up the call. `access` decides who may call and text from it.
 */
export const phoneNumbers = pgTable(
  "phone_numbers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    twilioSid: text("twilio_sid").notNull(),
    /** E.164, like +13035550123. */
    number: text("number").notNull(),
    label: text("label").notNull(),
    forwardTo: text("forward_to"),
    forwardUserId: uuid("forward_user_id").references(() => users.id, { onDelete: "set null" }),
    access: text("access").$type<"everyone" | "selected">().notNull().default("everyone"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("phone_numbers_sid_idx").on(t.twilioSid), uniqueIndex("phone_numbers_number_idx").on(t.number)],
);

/** With `access: "selected"`, the teammates who may use the number. */
export const phoneNumberUsers = pgTable(
  "phone_number_users",
  {
    phoneNumberId: uuid("phone_number_id")
      .notNull()
      .references(() => phoneNumbers.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.phoneNumberId, t.userId] })],
);

export type CallStatus = "initiated" | "ringing" | "in-progress" | "completed" | "busy" | "no-answer" | "failed" | "canceled";

/**
 * A call through one of the numbers: one made from the browser, or one that
 * came in and was forwarded. Each is a call activity on the record it matched
 * (`activities.call_id`); Twilio's status reports fill in how it went.
 */
export const phoneCalls = pgTable(
  "phone_calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Twilio's id for the call. Browser calls get it when Twilio first asks what to do. */
    callSid: text("call_sid"),
    phoneNumberId: uuid("phone_number_id").references(() => phoneNumbers.id, { onDelete: "set null" }),
    /** Who made it, or who it was forwarded to. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    direction: text("direction").$type<"inbound" | "outbound">().notNull(),
    from: text("from").notNull(),
    to: text("to").notNull(),
    status: text("status").$type<CallStatus>().notNull().default("initiated"),
    /** Incoming calls: the cell phone it rang. */
    forwardedTo: text("forwarded_to"),
    durationSeconds: integer("duration_seconds"),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("phone_calls_sid_idx").on(t.callSid), index("phone_calls_person_idx").on(t.personId)],
);

/**
 * A text conversation for the Messages page: everything between one of the
 * team's numbers and one outside number. `read` is one flag for the whole
 * conversation; whose it is depends on who owns the linked record
 * (src/lib/conversations/read-state.ts), so it follows the record when the owner changes.
 */
export const textThreads = pgTable(
  "text_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Our number. Null once the number is deleted: the conversation stays, but can't be replied to from here. */
    phoneNumberId: uuid("phone_number_id").references(() => phoneNumbers.id, { onDelete: "set null" }),
    /** Their number, E.164 as Twilio gave it. */
    remote: text("remote").notNull(),
    /** The last 10 digits of `remote` (src/lib/phone/numbers.ts `matchKey`), what conversations are matched on. */
    remoteKey: text("remote_key").notNull(),
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    read: boolean("read").notNull().default(true),
    /**
     * The latest one-to-one text either way. Campaign texts don't move it, so a
     * campaign doesn't push real conversations down the list; a conversation
     * with only campaign texts (null) isn't listed until someone replies.
     */
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("text_threads_number_remote_idx").on(t.phoneNumberId, t.remoteKey).where(sql`${t.phoneNumberId} is not null`),
    index("text_threads_last_idx").on(t.lastMessageAt),
    // The newest change to a conversation, for the open-page refresh check (src/lib/live.ts).
    index("text_threads_updated_idx").on(t.updatedAt),
    // The sidebar's unread count (src/lib/sidebar-counts.ts) and the Messages page's.
    index("text_threads_unread_idx").on(t.lastMessageAt).where(sql`not ${t.read}`),
    index("text_threads_person_idx").on(t.personId),
    index("text_threads_org_idx").on(t.organizationId),
  ],
);

export type TextStatus = "queued" | "sending" | "sent" | "delivered" | "undelivered" | "failed" | "received";

/** A text through one of the numbers, either way. Each is a text activity on the person it matched. */
export const textMessages = pgTable(
  "text_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageSid: text("message_sid"),
    phoneNumberId: uuid("phone_number_id").references(() => phoneNumbers.id, { onDelete: "set null" }),
    direction: text("direction").$type<"inbound" | "outbound">().notNull(),
    from: text("from").notNull(),
    to: text("to").notNull(),
    body: text("body").notNull().default(""),
    /** Pictures and files sent with an incoming text (Twilio media URLs, which need the account's credentials to open). */
    media: jsonb("media").$type<{ url: string; contentType: string }[]>().notNull().default([]),
    status: text("status").$type<TextStatus>().notNull().default("queued"),
    /** Why it wasn't delivered, in Twilio's words. */
    error: text("error"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
    /** The conversation it's part of, on the Messages page. */
    threadId: uuid("thread_id").references(() => textThreads.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("text_messages_sid_idx").on(t.messageSid),
    index("text_messages_thread_idx").on(t.threadId, t.createdAt),
    uniqueIndex("text_messages_campaign_person_idx").on(t.campaignId, t.personId),
    index("text_messages_person_idx").on(t.personId, t.createdAt),
  ],
);
