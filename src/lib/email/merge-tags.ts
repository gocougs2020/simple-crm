/**
 * Merge tags, shared by the editors (which offer them) and the senders (which
 * fill them). A tag is written {{first_name}} or, with text to use when the
 * value is missing, {{first_name|there}}. A person's custom fields are
 * {{custom.<key>}}, using the field's stable key.
 */
export const mergeTags = [
  "first_name",
  "last_name",
  "full_name",
  "email",
  "job_title",
  "company",
  "client_name",
  "owner_name",
  "owner_first_name",
  "sender_name",
  "sender_first_name",
] as const;
export type MergeTag = (typeof mergeTags)[number];

export const mergeTagLabels: Record<MergeTag, string> = {
  first_name: "First name",
  last_name: "Last name",
  full_name: "Full name",
  email: "Email address",
  job_title: "Job title",
  company: "Company",
  client_name: "Client name",
  owner_name: "Their owner's name",
  owner_first_name: "Their owner's first name",
  sender_name: "Your name",
  sender_first_name: "Your first name",
};

/**
 * Tags that mean something in a campaign. Campaigns have no single sender,
 * and a client name is only there when the audience filters by client.
 */
export const campaignMergeTags = mergeTags.filter((t) => !t.startsWith("sender"));

/** Used when a tag has no fallback of its own. */
const defaultFallbacks: Partial<Record<MergeTag, string>> = { first_name: "there", full_name: "there" };

export type MergeValues = Partial<Record<MergeTag, string | null>> & {
  /** Custom field values by key, already turned into text. */
  custom?: Record<string, string | null>;
};

const pattern = () => /\{\{\s*([a-z_]+|custom\.[a-z0-9_]+)\s*(?:\|([^{}|]*))?\}\}/gi;

/** The text a custom field value reads as in an email: lists joined with commas, checkboxes as Yes/No. */
export function customValueText(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (Array.isArray(v)) return v.length ? v.join(", ") : null;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

export type MergeSource = {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  title?: string | null;
  organizationName?: string | null;
  clientName?: string | null;
  ownerName?: string | null;
  custom?: Record<string, unknown> | null;
};

export function mergeValues(p: MergeSource, sender?: { name: string }): MergeValues {
  return {
    first_name: p.firstName ?? null,
    last_name: p.lastName ?? null,
    full_name: [p.firstName, p.lastName].filter(Boolean).join(" ") || null,
    email: p.email ?? null,
    job_title: p.title ?? null,
    company: p.organizationName ?? null,
    client_name: p.clientName ?? null,
    owner_name: p.ownerName ?? null,
    owner_first_name: p.ownerName?.split(" ")[0] ?? null,
    sender_name: sender?.name ?? null,
    sender_first_name: sender?.name.split(" ")[0] ?? null,
    custom: Object.fromEntries(Object.entries(p.custom ?? {}).map(([k, v]) => [k, customValueText(v)])),
  };
}

/**
 * Fills tags. Missing values use the tag's fallback (which came from the
 * author, so it's already in the right format); only real values go through
 * `escape`. Unknown tags are left alone, except {{unsubscribe_url}}, which
 * campaigns fill separately.
 */
export function fillMergeTags(text: string, values: MergeValues, escape: (s: string) => string = (s) => s) {
  return text.replace(pattern(), (match, raw: string, fallback?: string) => {
    const name = raw.toLowerCase();
    let v: string | null | undefined;
    if (name.startsWith("custom.")) v = values.custom?.[name.slice(7)];
    else if ((mergeTags as readonly string[]).includes(name)) v = values[name as MergeTag];
    else return match;
    v = v?.trim();
    return v ? escape(v) : (fallback ?? defaultFallbacks[name as MergeTag] ?? "");
  });
}

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Fills tags in rich-text HTML: chips from the editor become plain values. */
export function fillMergeTagsHtml(html: string, values: MergeValues) {
  const unchipped = html.replace(/<span[^>]*\bdata-merge-tag="[^"]*"[^>]*>([\s\S]*?)<\/span>/gi, "$1");
  return fillMergeTags(unchipped, values, escapeHtml);
}
