import "server-only";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { CustomValues } from "@/db/schema";
import { assertCan, type Actor } from "@/lib/crm/actor";
import { getOrganization, getPerson } from "@/lib/crm/records";
import { ActionError, NotFoundError } from "@/lib/errors";
import { personName } from "@/lib/format";
import { enrichPrompt, type EnrichEntity, type EnrichField } from "./enrich-rules";
import { startRun } from "./runs";

/**
 * Enrich a person or an organization: a background run that researches it
 * on the web, fills in the empty fields it's sure of, and leaves a note on
 * the record with everything it found (rules and the request in
 * enrich-rules.ts; the note is written when the run ends, in runs.ts).
 * Clients aren't enriched: they're relationships the team defines, not
 * something the web knows about.
 */
export async function startEnrichment(actor: Actor, entity: EnrichEntity, id: string) {
  // Checked before the record is read; startRun checks again, with the rest of what starting work needs.
  assertCan(actor, "records:write");
  const db = await getDb();
  const record = entity === "person" ? await personRecord(id) : await organizationRecord(id);
  // One at a time per record: a second click while it's working would pay twice for the same note.
  const key = entity === "person" ? schema.agentRuns.personId : schema.agentRuns.organizationId;
  const [going] = await db
    .select({ id: schema.agentRuns.id })
    .from(schema.agentRuns)
    .where(and(eq(key, id), eq(schema.agentRuns.source, "enrich"), inArray(schema.agentRuns.status, ["queued", "running"])))
    .limit(1);
  if (going) throw new ActionError(`${record.name} is already being enriched. Its note shows in the history when it's done.`);
  const fields = [...record.fields, ...(await customFields(entity, record.custom))];
  return startRun(actor, {
    source: "enrich",
    title: `Enrich ${record.name}`,
    prompt: enrichPrompt({ entity, id, name: record.name, context: record.context, fields }),
    ...(entity === "person" ? { personId: id } : { organizationId: id }),
  });
}

async function personRecord(id: string) {
  const row = await getPerson(id);
  if (!row || row.person.archivedAt) throw new NotFoundError("That person doesn't exist.");
  const { person: p, organization: o } = row;
  const fields: EnrichField[] = [
    { label: "Email", field: "email", value: p.email },
    { label: "Phone", field: "phone", value: p.phone },
    { label: "Job title", field: "title", value: p.title },
  ];
  const context = [
    `Name: ${personName(p)}`,
    o ? `Organization: ${o.name}${o.domain ? ` (${o.domain})` : ""}${o.address ? `, ${o.address.replace(/\s+/g, " ")}` : ""}` : "Organization: none in the CRM",
    ...(p.otherEmails.length ? [`Other emails: ${p.otherEmails.join(", ")}`] : []),
  ];
  return { name: personName(p), fields, context, custom: p.custom };
}

async function organizationRecord(id: string) {
  const o = await getOrganization(id);
  if (!o || o.archivedAt) throw new NotFoundError("That organization doesn't exist.");
  const fields: EnrichField[] = [
    { label: "Website", field: "domain", value: o.domain },
    { label: "Phone", field: "phone", value: o.phone },
    { label: "Industry", field: "industry", value: o.industry },
    { label: "Address", field: "address", value: o.address },
  ];
  return { name: o.name, fields, context: [`Name: ${o.name}`], custom: o.custom };
}

/** The record's custom fields the web could answer; a checkbox is the team's call, not a fact to look up. */
async function customFields(entity: EnrichEntity, values: CustomValues): Promise<EnrichField[]> {
  const db = await getDb();
  const defs = await db
    .select()
    .from(schema.customFields)
    .where(and(eq(schema.customFields.entityType, entity), isNull(schema.customFields.archivedAt)))
    .orderBy(asc(schema.customFields.position));
  return defs.filter((d) => d.type !== "checkbox").map((d) => ({ label: d.label, field: `custom.${d.key}`, value: values[d.key], type: d.type, options: d.options }));
}
