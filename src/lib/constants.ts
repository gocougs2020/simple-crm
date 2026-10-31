/** Shared by the database schema and client components (keeps drizzle out of client bundles). */

export const userRoles = ["owner", "admin", "member"] as const;
export type UserRole = (typeof userRoles)[number];

export const entityTypes = ["person", "organization", "deal"] as const;
export type EntityType = (typeof entityTypes)[number];

export const dealStatuses = ["open", "won", "lost"] as const;
export type DealStatus = (typeof dealStatuses)[number];

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
  deal: { one: "Deal", many: "Deals", path: "/deals" },
};

export const lostReasons = ["Price", "Went with a competitor", "No budget", "No decision", "Timing", "Not a fit", "Unresponsive"] as const;

/** Files people can attach to records. Executables and HTML are refused because they can carry script. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
