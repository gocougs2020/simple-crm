import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { CustomValues } from "@/db/schema";
import { ActionError } from "@/lib/auth";
import type { EntityType } from "@/lib/constants";
import { parseMoney } from "@/lib/format";
import { safeHref } from "@/lib/safe-html";

/**
 * Checks and normalizes custom field values against their definitions.
 * Unknown keys are dropped, blanks become null, and each type is coerced
 * (numbers to numbers, money to cents, options must exist).
 */
export async function cleanCustomValues(entity: EntityType, input: Record<string, unknown>): Promise<CustomValues> {
  const db = await getDb();
  const defs = await db
    .select()
    .from(schema.customFields)
    .where(and(eq(schema.customFields.entityType, entity), isNull(schema.customFields.archivedAt)));
  const out: CustomValues = {};
  for (const def of defs) {
    if (!(def.key in input)) continue;
    const raw = input[def.key];
    const blank = raw === null || raw === undefined || raw === "" || (Array.isArray(raw) && raw.length === 0);
    if (blank) {
      out[def.key] = def.type === "checkbox" ? false : null;
      continue;
    }
    const bad = (why: string) => new ActionError(`${def.label}: ${why}`);
    switch (def.type) {
      case "number": {
        const n = Number(String(raw).replace(/,/g, ""));
        if (!Number.isFinite(n)) throw bad("enter a number.");
        out[def.key] = n;
        break;
      }
      case "currency": {
        const c = typeof raw === "number" ? raw : parseMoney(String(raw));
        if (c === null) throw bad("enter an amount, like 12,500.");
        out[def.key] = c;
        break;
      }
      case "date":
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) throw bad("pick a date.");
        out[def.key] = String(raw);
        break;
      case "checkbox":
        out[def.key] = raw === true || raw === "true" || raw === "on";
        break;
      case "select":
        if (!def.options.includes(String(raw))) throw bad("pick one of the options.");
        out[def.key] = String(raw);
        break;
      case "multiselect": {
        const values = (Array.isArray(raw) ? raw : [raw]).map(String).filter((v) => def.options.includes(v));
        out[def.key] = values;
        break;
      }
      case "url": {
        const href = safeHref(String(raw).trim());
        if (!href) throw bad("enter a web address.");
        out[def.key] = href.slice(0, 500);
        break;
      }
      case "email":
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(raw).trim())) throw bad("enter a valid email address.");
        out[def.key] = String(raw).trim().toLowerCase();
        break;
      default:
        out[def.key] = String(raw).slice(0, def.type === "longtext" ? 10_000 : 500);
    }
  }
  return out;
}

/** Labels for custom keys, so history entries read "Budget: $5,000 → $8,000". */
export async function customLabels(entity: EntityType) {
  const db = await getDb();
  const defs = await db.select({ key: schema.customFields.key, label: schema.customFields.label }).from(schema.customFields).where(eq(schema.customFields.entityType, entity));
  return Object.fromEntries(defs.map((d) => [d.key, d.label]));
}
