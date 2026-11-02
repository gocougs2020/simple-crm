/** Shared by the database schema and client components (keeps drizzle out of client bundles). */

export const userRoles = ["owner", "admin", "member"] as const;
export type UserRole = (typeof userRoles)[number];

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

export const billingIntervals = ["month", "quarter", "year", "once"] as const;
export type BillingInterval = (typeof billingIntervals)[number];
export const billingIntervalLabels: Record<BillingInterval, { label: string; per: string }> = {
  month: { label: "Monthly", per: "/mo" },
  quarter: { label: "Quarterly", per: "/qtr" },
  year: { label: "Yearly", per: "/yr" },
  once: { label: "One time", per: "" },
};
/** For monthly recurring revenue: how many of this interval fit in a month. One-time fees don't recur. */
export const monthlyFactor: Record<BillingInterval, number> = { month: 1, quarter: 1 / 3, year: 1 / 12, once: 0 };

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
