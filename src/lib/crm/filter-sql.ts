import { and, or, sql, type SQL } from "drizzle-orm";
import type { EntityType } from "@/lib/constants";
import { findField, negations, type CustomFieldDef, type FieldKind, type FilterCondition, type FilterConditions, type Operator } from "./filter-fields";

/**
 * Saved filters as SQL: a condition list (src/lib/crm/filter-fields.ts)
 * becomes one WHERE fragment on the People, Organizations or Clients query.
 * The record being listed is referred to by its table's name ("people",
 * "organizations", "clients"), which every list query has in scope; a
 * related record is read in a subquery under its own alias, so it never
 * collides with the joins those queries already make.
 */

const tables: Record<EntityType, string> = { person: "people", organization: "organizations", client: "clients" };
const aliases: Record<EntityType, string> = { person: "sf_p", organization: "sf_o", client: "sf_c" };

/** A column of the row `t` (a table name or alias). */
const col = (name: string) => (t: SQL) => sql`${t}.${sql.identifier(name)}`;
type Expr = (t: SQL) => SQL;

const builtIn: Record<string, Expr> = {
  "person.name": (t) => sql`trim(${t}.first_name || ' ' || coalesce(${t}.last_name, ''))`,
  "person.email": col("email"),
  "person.phone": col("phone"),
  "person.title": col("title"),
  "person.owner": (t) => sql`${t}.owner_id::text`,
  // Their own labels and the ones they carry from their organization, as the People list's label filter matches.
  "person.labels": (t) => sql`(${t}.tags || coalesce((select sf_lo.tags from organizations sf_lo where sf_lo.id = ${t}.organization_id), '[]'::jsonb))`,
  "person.decisionMaker": col("decision_maker"),
  "person.emailOptIn": (t) => sql`(${t}.marketing_opt_in and ${t}.unsubscribed_at is null)`,
  "person.created": col("created_at"),
  "person.lastActivity": col("last_activity_at"),
  "person.lastCampaign": col("last_campaign_at"),

  "organization.name": col("name"),
  "organization.website": col("domain"),
  "organization.phone": col("phone"),
  "organization.address": col("address"),
  "organization.industry": col("industry"),
  "organization.owner": (t) => sql`${t}.owner_id::text`,
  "organization.labels": col("tags"),
  "organization.parent": (t) => sql`${t}.parent_id::text`,
  "organization.isParent": col("is_parent"),
  "organization.people": (t) => sql`(select count(*)::int from people sf_pc where sf_pc.organization_id = ${t}.id and sf_pc.archived_at is null)`,
  "organization.created": col("created_at"),
  "organization.lastActivity": col("last_activity_at"),

  "client.name": col("name"),
  "client.category": col("category"),
  "client.pipeline": (t) => sql`${t}.pipeline_id::text`,
  "client.stage": (t) => sql`${t}.stage_id::text`,
  "client.owner": (t) => sql`${t}.owner_id::text`,
  "client.value": col("value"),
  "client.health": col("health"),
  "client.churnReason": col("churn_reason"),
  "client.openToReturn": col("open_to_return"),
  "client.labels": col("tags"),
  "client.productLines": col("product_lines"),
  "client.stripeProducts": col("stripe_products"),
  "client.billing": col("stripe_status"),
  "client.mrr": col("stripe_mrr"),
  "client.expectedClose": col("expected_close_date"),
  "client.startedOn": col("started_on"),
  "client.endedOn": col("ended_on"),
  "client.stageChanged": col("stage_changed_at"),
  "client.created": col("created_at"),
  "client.lastActivity": col("last_activity_at"),
};

/** A custom value read from the record's `custom` JSON as the kind it's compared as; anything that isn't one reads as empty. */
function customExpr(key: string, kind: FieldKind): Expr {
  return (t) => {
    const raw = sql`(${t}.custom ->> ${key})`;
    switch (kind) {
      case "number":
      case "money":
        return sql`(case when ${raw} ~ '^\\s*-?[0-9]+(\\.[0-9]+)?\\s*$' then ${raw}::numeric end)`;
      case "date":
        return sql`(case when ${raw} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then substr(${raw}, 1, 10)::date end)`;
      case "multi":
        return sql`(case when jsonb_typeof(${t}.custom -> ${key}) = 'array' then ${t}.custom -> ${key} else '[]'::jsonb end)`;
      case "boolean":
        return sql`(${raw} = 'true')`;
      default:
        return raw;
    }
  };
}

const list = (values: string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);
const escapeLike = (q: string) => `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const asList = (v: FilterCondition["value"]) => (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []).filter(Boolean);
const asNumber = (v: FilterCondition["value"]) => (typeof v === "number" ? v : Number(v));

/** The condition with an operator that picks records (never one of the negations), or null when it can't be read. */
function positive(e: SQL, kind: FieldKind, op: Operator, value: FilterCondition["value"]): SQL | null {
  switch (op) {
    case "is":
      return typeof value === "string" ? sql`lower(${e}) = lower(${value})` : null;
    case "contains":
      return typeof value === "string" && value.trim() ? sql`${e} ilike ${escapeLike(value)}` : null;
    case "eq":
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const n = asNumber(value);
      if (!Number.isFinite(n)) return null;
      const cmp = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=" }[op];
      return sql`${e} ${sql.raw(cmp)} ${n}::numeric`;
    }
    case "before":
    case "after":
      return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? sql`${e}::date ${sql.raw(op === "before" ? "<" : ">")} ${value}::date` : null;
    case "within_days":
    case "next_days": {
      const n = asNumber(value);
      if (!Number.isInteger(n) || n < 0) return null;
      return op === "within_days" ? sql`(${e}::date >= current_date - ${n}::int and ${e}::date <= current_date)` : sql`(${e}::date >= current_date and ${e}::date <= current_date + ${n}::int)`;
    }
    case "any_of": {
      const values = asList(value);
      return values.length ? sql`${e} in (${list(values)})` : null;
    }
    case "has_any":
    case "has_all": {
      const values = asList(value);
      return values.length ? sql`${e} ${sql.raw(op === "has_any" ? "?|" : "?&")} array[${list(values)}]::text[]` : null;
    }
    case "is_true":
      return e;
    case "not_empty":
      if (kind === "multi") return sql`jsonb_array_length(${e}) > 0`;
      if (kind === "text" || kind === "choice") return sql`coalesce(${e}, '') <> ''`;
      return sql`${e} is not null`;
    default:
      return null;
  }
}

/** How a related record is tied to the one being listed: `r` is the related row, `base` the listed one. */
function tie(base: EntityType, related: EntityType, r: SQL): { one: boolean; on: SQL } | null {
  const b = (c: string) => sql`${sql.identifier(tables[base])}.${sql.identifier(c)}`;
  if (base === "person" && related === "organization") return { one: true, on: sql`${r}.id = ${b("organization_id")}` };
  if (base === "client" && related === "organization") return { one: true, on: sql`${r}.id = ${b("organization_id")}` };
  if (base === "client" && related === "person") return { one: true, on: sql`${r}.id = ${b("person_id")}` };
  // Their clients: ones they're the contact on or were added to, and the clients of their organization.
  if (base === "person" && related === "client")
    return {
      one: false,
      on: sql`(${r}.person_id = ${b("id")} or exists (select 1 from client_people sf_cp where sf_cp.client_id = ${r}.id and sf_cp.person_id = ${b("id")}) or (${b("organization_id")} is not null and (${r}.organization_id = ${b("organization_id")} or exists (select 1 from client_organizations sf_co where sf_co.client_id = ${r}.id and sf_co.organization_id = ${b("organization_id")}))))`,
    };
  // People at it: their main organization, or one they're also at.
  if (base === "organization" && related === "person")
    return { one: false, on: sql`(${r}.organization_id = ${b("id")} or exists (select 1 from person_organizations sf_po where sf_po.person_id = ${r}.id and sf_po.organization_id = ${b("id")}))` };
  if (base === "organization" && related === "client")
    return { one: false, on: sql`(${r}.organization_id = ${b("id")} or exists (select 1 from client_organizations sf_co where sf_co.client_id = ${r}.id and sf_co.organization_id = ${b("id")}))` };
  return null;
}

/** One condition as SQL, on the record being listed. A condition that can't be read matches nothing, so a broken filter never widens a list. */
export function conditionSql(base: EntityType, c: FilterCondition, custom: CustomFieldDef[]): SQL {
  const field = findField(c.field, custom);
  if (!field) return sql`false`;
  const negated = negations[c.op];
  const op = negated ?? c.op;
  const expr = field.key.includes(".custom.") ? customExpr(field.key.split(".").slice(2).join("."), field.kind) : builtIn[field.key];
  if (!expr) return sql`false`;
  const self = field.entity === base;
  const row = sql`${sql.identifier(self ? tables[base] : aliases[field.entity])}`;
  const p = positive(expr(row), field.kind, op, c.value);
  if (!p) return sql`false`;
  if (self) return negated ? sql`not coalesce(${p}, false)` : sql`coalesce(${p}, false)`;
  const how = tie(base, field.entity, row);
  if (!how) return sql`false`;
  const found = sql`exists (select 1 from ${sql.identifier(tables[field.entity])} ${row} where ${how.on} and ${row}.archived_at is null and coalesce(${p}, false))`;
  return negated ? sql`not ${found}` : found;
}

/** The whole filter: every condition in `all`, and at least one in `any`. Undefined when it has none. */
export function filterSql(base: EntityType, f: FilterConditions, custom: CustomFieldDef[]): SQL | undefined {
  const all = f.all.map((c) => conditionSql(base, c, custom));
  const any = f.any.map((c) => conditionSql(base, c, custom));
  const parts = [...all, ...(any.length ? [or(...any)!] : [])];
  return parts.length ? sql`(${and(...parts)})` : undefined;
}
