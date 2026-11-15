"use server";

import { refresh } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { run, type Result } from "@/lib/action";
import { ActionError, actionEditor, actionUser, isAdmin } from "@/lib/auth";
import { audienceSchema, type AudienceInput } from "@/lib/email/audience-schema";
import { audienceCount, resolveAudience } from "@/lib/email/campaigns";

const { audiences } = schema;
const uuid = z.uuid();

const saveInput = z.object({
  name: z.string().trim().min(1, "Name the audience.").max(120),
  description: z.string().trim().max(500).nullable().optional(),
  filters: audienceSchema,
});

/** Creates or updates a saved audience. Campaigns that use it pick up the change when they send. */
export async function saveAudience(audienceId: string | null, input: z.input<typeof saveInput>): Promise<Result<{ id: string }>> {
  return run(async () => {
    const user = await actionEditor();
    const data = saveInput.parse(input);
    const db = await getDb();
    if (!audienceId) {
      const [row] = await db
        .insert(audiences)
        .values({ ...data, description: data.description || null, createdBy: user.id })
        .returning({ id: audiences.id });
      refresh();
      return row;
    }
    const rows = await db
      .update(audiences)
      .set({ ...data, description: data.description || null, updatedAt: new Date() })
      .where(eq(audiences.id, uuid.parse(audienceId)))
      .returning({ id: audiences.id });
    if (!rows.length) throw new ActionError("This audience was deleted.");
    refresh();
    return rows[0];
  });
}

/**
 * Deletes a saved audience. Campaigns that used it keep the filters it had
 * when they last saved, so nothing already scheduled loses its recipients.
 */
export async function deleteAudience(audienceId: string): Promise<Result> {
  return run(async () => {
    const user = await actionEditor();
    const db = await getDb();
    const id = uuid.parse(audienceId);
    const where = isAdmin(user) ? eq(audiences.id, id) : and(eq(audiences.id, id), eq(audiences.createdBy, user.id));
    const rows = await db.delete(audiences).where(where).returning({ id: audiences.id });
    if (!rows.length) throw new ActionError("Only the person who made this audience, or an admin, can delete it.");
    refresh();
  });
}

/** How many people match right now, and the first few of them, for the audience editors. */
export async function previewAudience(filters: AudienceInput) {
  await actionUser();
  const a = audienceSchema.parse(filters);
  const [count, sample] = await Promise.all([audienceCount(a), resolveAudience(a, 8)]);
  return { count, sample: sample.map((p) => ({ id: p.id, name: [p.firstName, p.lastName].filter(Boolean).join(" "), email: p.email, organizationName: p.organizationName, clientName: p.clientName })) };
}
