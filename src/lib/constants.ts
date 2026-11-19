/** Shared by the database schema and client components (keeps drizzle out of client bundles). */

export const userRoles = ["owner", "admin", "member", "viewer"] as const;
export type UserRole = (typeof userRoles)[number];

export const roleLabels: Record<UserRole, string> = { owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" };
export const roleHints: Record<UserRole, string> = {
  owner: "Everything admins can do, plus deciding who owns the workspace.",
  admin: "Works every record and manages settings, pipelines, fields, the team and workspace API keys.",
  member: "Works every record: creates, edits and archives them, and logs activity. Can't change settings.",
  viewer: "Sees every record but can't change anything. Their MCP access is read-only too.",
};

/**
 * API keys: a workspace key acts with full access for integrations; a
 * personal key acts as one teammate, with their role. An "oauth" key is a
 * connected app (Claude, ChatGPT…) a teammate approved through OAuth: it also
 * acts as them, and its access tokens come and go while the grant stays.
 * Personal keys and connected apps work with MCP; workspace keys don't.
 * An "assistant" row stands for a teammate's in-app agent: it holds no
 * usable token (the agent runs on their signed-in session) and exists so
 * history can say "Sam via Agent".
 */
export const apiKeyKinds = ["workspace", "personal", "oauth", "assistant"] as const;
export type ApiKeyKind = (typeof apiKeyKinds)[number];
/** The kinds people create by hand in Settings. */
export const manualKeyKinds = ["workspace", "personal"] as const;
export type ManualKeyKind = (typeof manualKeyKinds)[number];

export const entityTypes = ["person", "organization", "client"] as const;
export type EntityType = (typeof entityTypes)[number];

/**
 * Every client sits in one of three buckets. The bucket decides which stages
 * they move through and what their record shows: prospects get pipeline
 * value, current clients get account management, past clients get what they
 * had and why they left.
 */
export const clientCategories = ["prospective", "current", "past"] as const;
export type ClientCategory = (typeof clientCategories)[number];

export const clientCategoryLabels: Record<ClientCategory, { one: string; many: string; hint: string }> = {
  prospective: { one: "Prospective", many: "Prospective", hint: "Anyone we've talked to who might become a client." },
  current: { one: "Current", many: "Current", hint: "Paying clients we manage today." },
  past: { one: "Past", many: "Past", hint: "Former clients: what they had, why they left, and whether to win them back." },
};

/** How a current client is doing, set by their account manager. */
export const clientHealths = ["good", "watch", "at_risk"] as const;
export type ClientHealth = (typeof clientHealths)[number];
export const clientHealthLabels: Record<ClientHealth, string> = { good: "Healthy", watch: "Watch", at_risk: "At risk" };

export const billingIntervals = ["month", "four_weeks", "quarter", "year", "once"] as const;
export type BillingInterval = (typeof billingIntervals)[number];
export const billingIntervalLabels: Record<BillingInterval, { label: string; per: string }> = {
  month: { label: "Monthly", per: "/mo" },
  four_weeks: { label: "Every 4 weeks", per: "/4 wks" },
  quarter: { label: "Quarterly", per: "/qtr" },
  year: { label: "Yearly", per: "/yr" },
  once: { label: "One time", per: "" },
};
/** For monthly recurring revenue: how many of this interval fit in a month. Every 4 weeks is 13 payments a year, so a little more than one a month. One-time fees don't recur. */
export const monthlyFactor: Record<BillingInterval, number> = { month: 1, four_weeks: 13 / 12, quarter: 1 / 3, year: 1 / 12, once: 0 };
/** `monthlyFactor` in SQL, for a `client_services` row aliased `cs`. Keep the two in step. */
export const monthlyPriceSql = "case cs.interval when 'month' then cs.price when 'four_weeks' then cs.price * 13 / 12.0 when 'quarter' then cs.price / 3.0 when 'year' then cs.price / 12.0 else 0 end";

/** Why a client left. The list is a starting point; anything can be typed instead. */
export const churnReasons = ["Price", "Switched to a competitor", "Budget cut", "Didn't see results", "Service issues", "No longer needed", "Business closed", "Contract ended"] as const;

/**
 * Interactions people log by hand, plus tasks. Order is the order of the
 * composer tabs. `email` covers both emails sent from the CRM and ones logged
 * by hand (sent from Gmail, say).
 */
export const activityTypes = ["note", "call", "email", "text", "meeting", "task"] as const;
export type ActivityType = (typeof activityTypes)[number];

export const activityLabels: Record<ActivityType, string> = {
  note: "Note",
  call: "Call",
  email: "Email",
  text: "Text",
  meeting: "Meeting",
  task: "Task",
};

/** Interactions with the other side. Notes and tasks are internal. */
export const interactionTypes: ActivityType[] = ["call", "email", "text", "meeting"];

export const callOutcomes = ["Connected", "Left voicemail", "No answer", "Wrong number", "Busy"] as const;
export const meetingOutcomes = ["Held", "No-show", "Rescheduled"] as const;

export const customFieldTypes = ["text", "longtext", "number", "currency", "date", "select", "multiselect", "checkbox", "url", "email", "phone"] as const;
export type CustomFieldType = (typeof customFieldTypes)[number];

export const customFieldTypeLabels: Record<CustomFieldType, string> = {
  text: "Text",
  longtext: "Long text",
  number: "Number",
  currency: "Money",
  date: "Date",
  select: "Single option",
  multiselect: "Multiple options",
  checkbox: "Checkbox",
  url: "Link",
  email: "Email",
  phone: "Phone",
};

export const entityLabels: Record<EntityType, { one: string; many: string; path: string }> = {
  person: { one: "Person", many: "People", path: "/people" },
  organization: { one: "Organization", many: "Organizations", path: "/organizations" },
  client: { one: "Client", many: "Clients", path: "/clients" },
};

/** Files people can attach to records. Executables and HTML are refused because they can carry script. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Attachments on one email, together. Resend accepts 40 MB once encoded and an
 * inbox draft 25 MB, so 20 MB of files leaves room for the message itself.
 */
export const MAX_EMAIL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_EMAIL_ATTACHMENTS = 10;

/**
 * Push notifications a teammate can turn on per device (Settings →
 * Notifications). Each one is about the teammate's own work, so nobody is
 * notified about something they did themselves.
 */
export const notificationKinds = ["task_assigned", "task_due", "task_digest", "meeting_soon", "record_assigned", "inbound_email", "inbound_text", "agent_done", "mention"] as const;
export type NotificationKind = (typeof notificationKinds)[number];
export const notificationLabels: Record<NotificationKind, { label: string; hint: string }> = {
  task_assigned: { label: "Tasks assigned to me", hint: "When a teammate (or their agent) gives you a task, call or meeting." },
  task_due: { label: "Tasks with a time", hint: "On the day, 15 minutes before a task or planned call with a time is due." },
  task_digest: { label: "Today's tasks, in the morning", hint: "One notification each morning for your tasks due today that have no time." },
  meeting_soon: { label: "Meetings", hint: "15 minutes before each of your meetings starts." },
  record_assigned: { label: "Records assigned to me", hint: "When a teammate makes you the owner of a client, person or organization." },
  inbound_email: { label: "Replies from my contacts", hint: "When email arrives in a connected inbox from a client, person or organization you own." },
  inbound_text: { label: "Texts from my contacts", hint: "When someone you own texts one of the team's phone numbers, or texts a number you look after." },
  mention: { label: "Mentions and replies", hint: "When a teammate mentions you in a note (@ and your name), or replies to a note you wrote or replied to." },
  agent_done: { label: "The agent finished", hint: "When background work you gave the agent is done, has a draft for you to approve, or couldn't finish." },
};

/** Where a background run of the agent came from (docs/AGENT.md). */
export const agentRunSources = ["chat", "mention", "task", "bulk", "api", "schedule"] as const;
export type AgentRunSource = (typeof agentRunSources)[number];
/** queued: accepted, not started. running: the agent is working. The rest are final. */
export const agentRunStatuses = ["queued", "running", "done", "failed", "cancelled"] as const;
export type AgentRunStatus = (typeof agentRunStatuses)[number];
export const agentRunStatusLabels: Record<AgentRunStatus, string> = { queued: "Starting", running: "Working", done: "Done", failed: "Couldn't finish", cancelled: "Cancelled" };
/** Messages the agent writes for a teammate to review and send. */
export const agentDraftKinds = ["email", "text"] as const;
export type AgentDraftKind = (typeof agentDraftKinds)[number];
export const agentDraftStatuses = ["pending", "sent", "discarded"] as const;
export type AgentDraftStatus = (typeof agentDraftStatuses)[number];
/**
 * Who a skill or scheduled job is for (docs/AGENT.md). personal: one teammate's own.
 * workspace: shared by an admin with everyone. A shared skill is used by every
 * teammate's agent; a shared job is offered, and runs for whoever adds it.
 */
export const agentScopes = ["personal", "workspace"] as const;
export type AgentScope = (typeof agentScopes)[number];
/** always: in the agent's instructions on every conversation. on_demand: listed, and read when the work calls for it. */
export const agentSkillModes = ["on_demand", "always"] as const;
export type AgentSkillMode = (typeof agentSkillModes)[number];
export const agentSkillModeLabels: Record<AgentSkillMode, { label: string; hint: string }> = {
  on_demand: { label: "When it's relevant", hint: "The agent reads it when a request matches the description." },
  always: { label: "Always", hint: "Part of the agent's instructions in every conversation. Keep it short." },
};
/** How often a scheduled job runs. once: on one date. */
export const scheduleEvery = ["day", "weekday", "week", "month", "once"] as const;
export type ScheduleEvery = (typeof scheduleEvery)[number];
export const agentRunActive = (status: AgentRunStatus) => status === "queued" || status === "running";

/** Agenda emails a teammate can get (Settings → Notifications), sent in the morning in the workspace's time zone. */
export const emailDigestKinds = ["daily", "weekly"] as const;
export type EmailDigestKind = (typeof emailDigestKinds)[number];
export const emailDigestLabels: Record<EmailDigestKind, { label: string; hint: string }> = {
  daily: { label: "Daily agenda, every weekday morning", hint: "Today's meetings, plus tasks due today and anything overdue. On Mondays the weekly agenda takes its place if it's on." },
  weekly: { label: "Weekly agenda, every Monday morning", hint: "This week's meetings, tasks due today or overdue, and tasks coming up later in the week." },
};

/** Campaigns go out as email (Resend) or as texts (Twilio). */
export const campaignChannels = ["email", "text"] as const;
export type CampaignChannel = (typeof campaignChannels)[number];

/**
 * What teammates see of someone's connected calendar in Calendar: nothing,
 * when they're busy, or the events themselves. CRM meetings and planned calls
 * are records, so everyone sees those either way.
 */
export const calendarSharings = ["none", "busy", "details"] as const;
export type CalendarSharing = (typeof calendarSharings)[number];
export const calendarSharingLabels: Record<CalendarSharing, { label: string; hint: string }> = {
  none: { label: "Only me", hint: "Teammates see the CRM meetings and calls you have, not the rest of your calendar." },
  busy: { label: "Free and busy", hint: "Teammates see when you're busy, without titles or details." },
  details: { label: "Full details", hint: "Teammates see your events' titles, times and places." },
};
