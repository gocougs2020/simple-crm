import "server-only";
import { appConfig } from "@/app.config";
import { cache } from "react";
import { asc, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { aiFeatures } from "@/lib/agent/config";
import { emailConfigured } from "@/lib/email";
import { blobConfigured } from "@/lib/files";
import { stripeConfigured } from "@/lib/stripe";
import { listLabels } from "@/lib/crm/labels";
import { listProductDescriptions } from "@/lib/crm/product-descriptions";
import { allStripeProducts, parentOrganizations } from "@/lib/crm/records";
import { getWorkspace } from "@/lib/workspace";
import { getVapid } from "@/lib/push/vapid";

export type TeamMember = { id: string; name: string; email: string; role: string; title: string | null; active: boolean };
export type Stage = typeof schema.stages.$inferSelect;
export type Pipeline = typeof schema.pipelines.$inferSelect & { stages: Stage[] };
export type CustomField = typeof schema.customFields.$inferSelect;

/**
 * Everything small and slow-changing the whole interface needs: the team, the
 * pipelines and their stages, custom field definitions, what each Stripe
 * product delivers, the parent organizations and workspace settings. Loaded once per request in the app layout and handed to the
 * browser, so owner pickers and stage menus open instantly.
 */
export const getAppData = cache(async () => {
  const db = await getDb();
  const [ws, users, pipelines, stages, fields, products, stripeProducts, keys, parents, labels, vapid] = await Promise.all([
    getWorkspace(),
    // Only what the team list shows: never the password hash or prefs, which go to the browser with this.
    db
      .select({
        id: schema.users.id,
        name: schema.users.name,
        email: schema.users.email,
        role: schema.users.role,
        title: schema.users.title,
        deactivatedAt: schema.users.deactivatedAt,
        hasPassword: sql<boolean>`${schema.users.passwordHash} is not null`,
      })
      .from(schema.users)
      .orderBy(asc(schema.users.name)),
    db.select().from(schema.pipelines).orderBy(asc(schema.pipelines.position), asc(schema.pipelines.createdAt)),
    db.select().from(schema.stages).orderBy(asc(schema.stages.position)),
    db.select().from(schema.customFields).where(isNull(schema.customFields.archivedAt)).orderBy(asc(schema.customFields.position), asc(schema.customFields.createdAt)),
    listProductDescriptions(),
    stripeConfigured() ? allStripeProducts() : [],
    // Names only (revoked ones too), so history can say which key made a change.
    db.select({ id: schema.apiKeys.id, name: schema.apiKeys.name, kind: schema.apiKeys.kind }).from(schema.apiKeys),
    parentOrganizations(),
    listLabels(),
    getVapid(),
  ]);
  return {
    workspace: { name: ws.name, currency: ws.currency, timezone: ws.timezone },
    team: users.map((u): TeamMember => ({ id: u.id, name: u.name, email: u.email, role: u.role, title: u.title, active: !u.deactivatedAt && u.hasPassword })),
    pipelines: pipelines.map((p): Pipeline => ({ ...p, stages: stages.filter((s) => s.pipelineId === p.id) })),
    customFields: fields,
    /** What each Stripe product delivers (Settings → Services), by its Stripe name. */
    products,
    /** The Stripe products clients are on now, by name: the choices for filtering by what they're subscribed to. */
    stripeProducts,
    /** Organizations marked as a parent, by name: the choices for an organization's parent, and for list and audience filters. */
    parentOrganizations: parents,
    /** What each label means and whether the app shows it (Settings → Labels). */
    labels,
    // The agent's own key rows carry whatever it was called when they were made; history shows its current name.
    apiKeys: keys.map((k) => (k.kind === "assistant" ? { ...k, name: appConfig.agent.name } : k)),
    services: { blob: blobConfigured(), email: emailConfigured(), emailFrom: process.env.RESEND_FROM ?? null, stripe: stripeConfigured(), ai: aiFeatures(), /** Public, so browsers can sign up for push; null when push isn't set up. */ pushKey: vapid?.publicKey ?? null },
  };
});

export type AppData = Awaited<ReturnType<typeof getAppData>>;
