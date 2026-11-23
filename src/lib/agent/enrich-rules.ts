import type { CustomFieldType } from "@/lib/constants";
import { MAX_RUN_PROMPT } from "./run-rules";

/**
 * Enrichment: the agent looks a person or an organization up on the public
 * web, fills in the empty fields it's sure of, and reports everything it
 * found as a note on the record (docs/AGENT.md#enrichment). Pure, so the
 * request it gets can be tested; src/lib/agent/enrich.ts starts the run.
 */

export const enrichEntities = ["person", "organization"] as const;
export type EnrichEntity = (typeof enrichEntities)[number];

export type EnrichField = {
  /** What the record page calls it. */
  label: string;
  /** The field to set through the update tool: `title`, or `custom.<key>` for a custom field. */
  field: string;
  value: unknown;
  /** Custom fields: their type, and the choices for a select. */
  type?: CustomFieldType;
  options?: string[];
};

export type EnrichRecord = {
  entity: EnrichEntity;
  id: string;
  name: string;
  /** What the researcher can go on that isn't a field to fill: the person's organization and its website. */
  context: string[];
  /** The fields it may fill, with what's in them now. */
  fields: EnrichField[];
};

const shown = (v: unknown) => {
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) return "(empty)";
  if (Array.isArray(v)) return v.join(", ");
  const text = String(v).replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
};

const fieldLine = (f: EnrichField) => {
  const kind = f.type ? ` [${f.type}${f.options?.length ? `: one of ${f.options.join(", ")}` : ""}]` : "";
  return `- ${f.label} (\`${f.field}\`${kind}): ${shown(f.value)}`;
};

/** The heading the note opens with, so the team can tell an enrichment report from other notes. */
export const ENRICH_NOTE_SUBJECT = "Enrichment from the web";

/**
 * The request a run gets when someone clicks Enrich on a record. The
 * instructions come first and the record last, so a record with a lot in it
 * loses its last fields to the request limit, never the instructions.
 */
export function enrichPrompt(r: EnrichRecord) {
  const tool = r.entity === "person" ? "crm__update_person" : "crm__update_organization";
  const what = r.entity === "person" ? "this person" : "this organization";
  const instructions = [
    `Enrich ${what} from the public web: find what's publicly known about them and fill in the record. What the CRM has now is at the end.`,
    "",
    "## How to do it",
    `1. Ask the researcher about ${r.name} in one call. Give it everything below that helps tell them apart from others with the same name (${r.entity === "person" ? "their organization, its website, their email's domain" : "the website, phone and address"}), and ask for the source link of every fact.`,
    `2. Fill in an empty field with ${tool} only when you're very confident: a source states the value plainly, and it's clearly about this ${r.entity} (the same name and ${r.entity === "person" ? "organization, or the same email" : "website, or the same address"}). Set custom fields through \`custom\`, by key, in the field's type.`,
    "3. Never replace a value that's already there. When a source disagrees with one, leave it and say so in the note.",
    `4. Change nothing else: not the name, owner, labels${r.entity === "person" ? ", organization, decision maker star or opt-ins" : ", parent organization or its people"}, and no other record. Don't guess an email address from a pattern.`,
    "",
    "## Your answer",
    `Your answer is saved as a note on the record, titled "${ENRICH_NOTE_SUBJECT}", so don't add a note yourself. Write it in these three parts, with these headings, and keep each line short:`,
    "- **Filled in**: each field you set, the value, and the link it came from. \"Nothing\" when you set none.",
    "- **Not sure**: what you found but didn't save, why you weren't sure (thin or disagreeing sources, maybe a different person or company, a field that already had a value), and the link. \"Nothing\" when there's none.",
    "- **Sources**: every page you used, as links.",
    "",
    `## What the CRM has now for ${r.name}`,
  ].join("\n");
  // Whole lines only, within the limit.
  let out = instructions;
  for (const line of [...r.context.map((c) => `- ${c}`), ...r.fields.map(fieldLine)]) {
    if (out.length + line.length + 1 > MAX_RUN_PROMPT) break;
    out += `\n${line}`;
  }
  return out;
}

/** The record an enrichment run works on. `id` is null when the record was deleted while it ran. */
export type EnrichScope = { entity: EnrichEntity; id: string | null };

/** The one update tool an enrichment run may call, for its record's kind. */
export const enrichUpdateTool = (entity: EnrichEntity) => (entity === "person" ? "update_person" : "update_organization");

/**
 * The tools an enrichment run gets, out of what any background run gets: it
 * reads, and it updates its own kind of record. It reads pages anyone can
 * write, so its scope is enforced here and in `enrichWriteProblem`, not left
 * to its instructions: a page that tells it to change something else finds no
 * tool to do it with.
 */
export const enrichMayUse = (op: { method: string; tool?: string }, entity: EnrichEntity) => op.method === "GET" || op.tool === enrichUpdateTool(entity);

/** Ids are UUIDs, which Postgres reads the same in either case. */
export const sameId = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);

/**
 * Why an enrichment run's update is refused, or null when it may go ahead: it
 * must be to the record being enriched, and may only fill fields it was
 * offered (`fields`, with what's in them now) that are still empty. Custom
 * fields come as `custom: { key: value }` and are checked one key at a time.
 */
export function enrichWriteProblem(scope: EnrichScope, target: { entity: EnrichEntity; id: unknown }, body: Record<string, unknown>, fields: EnrichField[]): string | null {
  if (target.entity !== scope.entity || !scope.id || !sameId(target.id, scope.id)) return `Enrichment only fills in the ${scope.entity} it was started on. Leave other records as they are.`;
  const offered = new Map(fields.map((f) => [f.field, f]));
  const changes = Object.entries(body).flatMap(([k, v]) =>
    k === "custom" && v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).map((c) => `custom.${c}`) : [k],
  );
  const notOffered = changes.filter((f) => !offered.has(f));
  if (notOffered.length) return `Enrichment only fills in the fields it was given. Leave ${notOffered.join(", ")} as they are.`;
  const filled = changes.filter((f) => !isEmpty(offered.get(f)!.value));
  if (filled.length) return `${filled.join(", ")} already has a value, and enrichment never replaces one. Mention what you found in the note instead.`;
  return null;
}
