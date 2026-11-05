/**
 * The rules that turn Pipedrive deals into clients. Pure functions, no I/O,
 * so the plan can be printed (`--dry-run`) before anything is written.
 *
 * In Pipedrive an organization can have a deal in several pipelines (a sales
 * deal, then one per product it bought). Here all of them collapse into one
 * client, in one of three categories:
 *
 * - current: an active deal in a product ("… Account Management") pipeline,
 *   or a won sales deal
 * - past: product deals only in a stopped stage ("Paused", "Terminated") or
 *   marked lost
 * - prospective: everything else (open or lost sales deals)
 *
 * Current beats past beats prospective. The client takes the stage of its
 * furthest deal in that category, verbatim, and each product deal becomes a
 * service on the client (ended when the deal stopped).
 */
import type { ClientCategory } from "@/lib/constants";
import type { PdDeal, PdId, PdPipeline, PdStage } from "./api";

/** Product pipelines are named "<Product> Account Management". Anything else is a sales pipeline. */
const PRODUCT_PIPELINE = /\s*account management\s*/i;
/** Stages in a product pipeline that mean the client stopped paying. */
const STOPPED = /paused|terminated/i;
/** Stages where a deal is parked rather than moving forward. They rank below active stages when picking the furthest deal. */
const PARKED = /incubate|lost|unqualified|cold follow|paused|terminated/i;
/** Stages that mean "don't contact again". */
const NO_RETURN = /don'?t\s+re-?(engage|vis)/i;

export type PipelineRole = { kind: "sales" } | { kind: "product"; service: string };

export function pipelineRole(p: PdPipeline): PipelineRole {
  if (!PRODUCT_PIPELINE.test(p.name)) return { kind: "sales" };
  return { kind: "product", service: p.name.replace(PRODUCT_PIPELINE, " ").trim() || p.name };
}

/** Stage names as shown here: Pipedrive's, trimmed of stray spaces. */
export const stageName = (s: PdStage) => s.name.trim().replace(/\s+/g, " ");

export type Lookup = { pipelines: Map<PdId, PdPipeline>; stages: Map<PdId, PdStage> };

export function dealCategory(deal: PdDeal, lk: Lookup): ClientCategory {
  const role = pipelineRole(lk.pipelines.get(deal.pipeline_id)!);
  const stage = lk.stages.get(deal.stage_id);
  // An archived product deal is one they no longer use, whatever stage it was left in.
  if (role.kind === "product") return deal.status === "lost" || deal.is_archived || (stage && STOPPED.test(stage.name)) ? "past" : "current";
  return deal.status === "won" ? "current" : "prospective";
}

const categoryOrder: ClientCategory[] = ["current", "past", "prospective"];

/** Sort key for "furthest along": deals not archived before archived ones, live before lost, moving stages before parked ones, then stage order, then most recently touched. */
function progress(deal: PdDeal, lk: Lookup) {
  const stage = lk.stages.get(deal.stage_id);
  return [deal.is_archived ? 0 : 1, deal.status === "lost" ? 0 : 1, stage && PARKED.test(stage.name) ? 0 : 1, stage?.order_nr ?? 0, Date.parse(deal.update_time ?? deal.add_time) || 0];
}

function compare(a: number[], b: number[]) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export type ClientPlan = {
  /** "org:12", "person:34" or "deal:56": what the client is keyed on in Pipedrive. */
  key: string;
  orgId: PdId | null;
  personId: PdId | null;
  deals: PdDeal[];
  category: ClientCategory;
  /** The deal whose stage the client takes. */
  lead: PdDeal;
  stage: PdStage;
  /** Set when every one of its deals is archived in Pipedrive: the latest archive time. */
  archivedAt: Date | null;
};

/** One client per organization (or per person, for deals with no organization). */
export function planClients(deals: PdDeal[], lk: Lookup): ClientPlan[] {
  const groups = new Map<string, PdDeal[]>();
  for (const d of deals) {
    if (d.status === "deleted" || d.is_deleted || !lk.pipelines.has(d.pipeline_id) || !lk.stages.has(d.stage_id)) continue;
    const key = d.org_id ? `org:${d.org_id}` : d.person_id ? `person:${d.person_id}` : `deal:${d.id}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  const plans: ClientPlan[] = [];
  for (const [key, list] of groups) {
    const category = categoryOrder.find((c) => list.some((d) => dealCategory(d, lk) === c))!;
    const lead = list.filter((d) => dealCategory(d, lk) === category).sort((a, b) => compare(progress(b, lk), progress(a, lk)))[0];
    const personId = lead.person_id ?? list.find((d) => d.person_id)?.person_id ?? null;
    const archived = list.every((d) => d.is_archived);
    const archivedAt = archived ? new Date(Math.max(...list.map((d) => Date.parse(d.archive_time ?? d.update_time ?? d.add_time) || 0))) : null;
    plans.push({ key, orgId: lead.org_id, personId, deals: list, category, lead, stage: lk.stages.get(lead.stage_id)!, archivedAt });
  }
  return plans;
}

export type StagePlan = { name: string; probability: number; sort: number[] };

/**
 * The stages each category's pipeline needs: the ones clients actually land
 * in, named exactly as in Pipedrive. Stages with the same name in several
 * Pipedrive pipelines (each product has "Implementation") become one.
 */
export function planStages(plans: ClientPlan[], lk: Lookup): Record<ClientCategory, StagePlan[]> {
  const out: Record<ClientCategory, Map<string, StagePlan>> = { prospective: new Map(), current: new Map(), past: new Map() };
  for (const p of plans) {
    const name = stageName(p.stage);
    const pipeline = lk.pipelines.get(p.stage.pipeline_id)!;
    const sales = pipelineRole(pipeline).kind === "sales";
    // In "current", a won sales deal ("Contract Signed") comes before onboarding stages.
    const sort = [PARKED.test(name) ? 1 : 0, p.category === "current" && sales ? 0 : 1, p.stage.order_nr, pipeline.order_nr];
    const prev = out[p.category].get(name);
    if (!prev || compare(sort, prev.sort) < 0) out[p.category].set(name, { name, probability: p.category === "prospective" ? (p.stage.deal_probability ?? 0) : 0, sort });
  }
  const sorted = (m: Map<string, StagePlan>) => [...m.values()].sort((a, b) => compare(a.sort, b.sort));
  return { prospective: sorted(out.prospective), current: sorted(out.current), past: sorted(out.past) };
}

/** Whether a past client should be in win-back campaigns. */
export const openToReturn = (stage: PdStage) => !NO_RETURN.test(stage.name);

/** Whether a product deal has ended (the client stopped that product). */
export const productEnded = (deal: PdDeal, lk: Lookup) => dealCategory(deal, lk) === "past";
