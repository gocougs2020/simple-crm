/** People import fields, shared by the import dialog and the server (keeps drizzle out of client bundles). */
export const importFields = [
  { key: "name", label: "Full name" },
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "title", label: "Job title" },
  { key: "organization", label: "Organization" },
  { key: "tags", label: "Tags" },
  { key: "notes", label: "Notes" },
  { key: "marketingOptIn", label: "Email opt-in" },
] as const;

export type ImportFieldKey = (typeof importFields)[number]["key"];

/** One spreadsheet row, mapped to fields. `row` is the line number in the file, for error messages. */
export type ImportRow = {
  row: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  title?: string;
  organization?: string;
  tags?: string[];
  notes?: string;
  marketingOptIn?: boolean;
};

export type ImportDefaults = { ownerId: string | null; marketingOptIn: boolean };
export type ImportChunkResult = { created: number; updated: number; unchanged: number; organizations: number; skipped: { row: number; reason: string }[] };

const synonyms: Record<ImportFieldKey, string[]> = {
  name: ["name", "fullname", "contact", "contactname", "displayname", "person"],
  firstName: ["firstname", "first", "givenname", "fname"],
  lastName: ["lastname", "last", "surname", "familyname", "lname"],
  email: ["email", "emailaddress", "mail", "workemail", "primaryemail", "email1"],
  phone: ["phone", "phonenumber", "mobile", "mobilephone", "cell", "cellphone", "telephone", "tel", "workphone", "phone1"],
  title: ["title", "jobtitle", "position", "role"],
  organization: ["organization", "organisation", "company", "companyname", "account", "accountname", "employer", "org"],
  tags: ["tags", "tag", "labels", "label", "groups", "categories"],
  notes: ["notes", "note", "comments", "comment", "description"],
  marketingOptIn: ["optin", "emailoptin", "subscribed", "marketing", "newsletter", "acceptsmarketing", "emailmarketing"],
};

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Best guess at the field for a column heading, or null to skip it. */
export function guessField(heading: string): ImportFieldKey | null {
  const h = normalize(heading);
  if (!h) return null;
  for (const f of importFields) if (synonyms[f.key].includes(h)) return f.key;
  // Looser matches like "Buyer Email" or "Home Phone #".
  if (h.includes("email")) return "email";
  if (h.includes("phone") || h.includes("mobile") || h.includes("cell")) return "phone";
  if (h.includes("company") || h.includes("organi")) return "organization";
  if (h.includes("first")) return "firstName";
  if (h.includes("last")) return "lastName";
  if (h.includes("note")) return "notes";
  return null;
}

export function parseOptIn(v: string): boolean | undefined {
  const s = v.trim().toLowerCase();
  if (["yes", "y", "true", "1", "subscribed", "opted in", "opt-in", "x"].includes(s)) return true;
  if (["no", "n", "false", "0", "unsubscribed", "opted out", "opt-out"].includes(s)) return false;
  return undefined;
}

export const splitTags = (v: string) =>
  v
    .split(/[,;|]/)
    .map((t) => t.trim().toLowerCase().slice(0, 40))
    .filter(Boolean);
