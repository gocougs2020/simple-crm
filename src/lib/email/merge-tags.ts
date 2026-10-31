/**
 * Merge tags, shared by the editors (which offer them) and the senders (which
 * fill them). A tag is written {{first_name}} or, with text to use when the
 * value is missing, {{first_name|there}}.
 */
export const mergeTags = ["first_name", "last_name", "full_name", "company", "sender_name", "sender_first_name"] as const;
export type MergeTag = (typeof mergeTags)[number];

export const mergeTagLabels: Record<MergeTag, string> = {
  first_name: "First name",
  last_name: "Last name",
  full_name: "Full name",
  company: "Company",
  sender_name: "Your name",
  sender_first_name: "Your first name",
};

/** Used when a tag has no fallback of its own. */
const defaultFallbacks: Partial<Record<MergeTag, string>> = { first_name: "there", full_name: "there" };

export type MergeValues = Partial<Record<MergeTag, string | null>>;

const pattern = () => /\{\{\s*([a-z_]+)\s*(?:\|([^{}|]*))?\}\}/gi;

export function mergeValues(p: { firstName?: string | null; lastName?: string | null; organizationName?: string | null }, sender?: { name: string }): MergeValues {
  return {
    first_name: p.firstName ?? null,
    last_name: p.lastName ?? null,
    full_name: [p.firstName, p.lastName].filter(Boolean).join(" ") || null,
    company: p.organizationName ?? null,
    sender_name: sender?.name ?? null,
    sender_first_name: sender?.name.split(" ")[0] ?? null,
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
    const tag = raw.toLowerCase() as MergeTag;
    if (!(mergeTags as readonly string[]).includes(tag)) return match;
    const v = values[tag]?.trim();
    return v ? escape(v) : (fallback ?? defaultFallbacks[tag] ?? "");
  });
}

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Fills tags in rich-text HTML: chips from the editor become plain values. */
export function fillMergeTagsHtml(html: string, values: MergeValues) {
  const unchipped = html.replace(/<span[^>]*\bdata-merge-tag="[^"]*"[^>]*>([\s\S]*?)<\/span>/gi, "$1");
  return fillMergeTags(unchipped, values, escapeHtml);
}
