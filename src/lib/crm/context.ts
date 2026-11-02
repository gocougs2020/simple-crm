import "server-only";
import { cache } from "react";
import { asc, isNull } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { emailConfigured } from "@/lib/email";
import { blobConfigured } from "@/lib/files";
import { stripeConfigured } from "@/lib/stripe";
import { getWorkspace } from "@/lib/workspace";

export type TeamMember = { id: string; name: string; email: string; role: string; title: string | null; active: boolean };
export type Stage = typeof schema.stages.$inferSelect;
export type Pipeline = typeof schema.pipelines.$inferSelect & { stages: Stage[] };
export type CustomField = typeof schema.customFields.$inferSelect;
export type Service = typeof schema.services.$inferSelect;

/**
 * Everything small and slow-changing the whole interface needs: the team, the
 * pipelines and their stages, custom field definitions, the services the
 * workspace sells and workspace settings. Loaded once per request in the app layout and handed to the
 * browser, so owner pickers and stage menus open instantly.
 */
export const getAppData = cache(async () => {
  const db = await getDb();
  const [ws, users, pipelines, stages, fields, services] = await Promise.all([
    getWorkspace(),
    db.select().from(schema.users).orderBy(asc(schema.users.name)),
    db.select().from(schema.pipelines).orderBy(asc(schema.pipelines.position), asc(schema.pipelines.createdAt)),
    db.select().from(schema.stages).orderBy(asc(schema.stages.position)),
    db.select().from(schema.customFields).where(isNull(schema.customFields.archivedAt)).orderBy(asc(schema.customFields.position), asc(schema.customFields.createdAt)),
    db.select().from(schema.services).orderBy(asc(schema.services.position), asc(schema.services.name)),
  ]);
  return {
    workspace: { name: ws.name, currency: ws.currency, timezone: ws.timezone },
    team: users.map((u): TeamMember => ({ id: u.id, name: u.name, email: u.email, role: u.role, title: u.title, active: !u.deactivatedAt && !!u.passwordHash })),
    pipelines: pipelines.map((p): Pipeline => ({ ...p, stages: stages.filter((s) => s.pipelineId === p.id) })),
    customFields: fields,
    /** Everything the workspace sells, archived ones included so existing subscriptions still show their name. */
    catalog: services,
    services: { blob: blobConfigured(), email: emailConfigured(), emailFrom: process.env.RESEND_FROM ?? null, stripe: stripeConfigured() },
  };
});

export type AppData = Awaited<ReturnType<typeof getAppData>>;
