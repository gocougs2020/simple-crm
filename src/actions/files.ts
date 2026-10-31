"use server";

import { refresh } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { run, type Result } from "@/lib/action";
import { ActionError, actionUser, isAdmin } from "@/lib/auth";
import { recordEvent, touch } from "@/lib/crm/events";
import { blobConfigured, cleanFileName, fileProblem } from "@/lib/files";

const links = z.object({ personId: z.uuid().nullable().optional(), organizationId: z.uuid().nullable().optional(), dealId: z.uuid().nullable().optional() });

/**
 * Records a file the browser just uploaded to Vercel Blob. The URL must be on
 * this store and under files/, the path our upload route issues tokens for.
 */
export async function attachUploadedFile(input: { url: string; pathname: string; name: string; size: number; contentType: string } & z.input<typeof links>): Promise<Result<{ id: string }>> {
  return run(async () => {
    const user = await actionUser();
    if (!blobConfigured()) throw new ActionError("File storage isn't set up.");
    const data = z
      .object({ url: z.url(), pathname: z.string().startsWith("files/").max(500), name: z.string().min(1).max(300), size: z.number().int().positive(), contentType: z.string().max(200) })
      .and(links)
      .parse(input);
    const host = new URL(data.url).hostname;
    if (!host.endsWith(".blob.vercel-storage.com")) throw new ActionError("That upload didn't come from file storage.");
    const problem = fileProblem(data.name, data.size, data.contentType);
    if (problem) throw new ActionError(problem);
    const db = await getDb();
    const [row] = await db
      .insert(schema.files)
      .values({ ...data, name: cleanFileName(data.name), uploadedBy: user.id })
      .returning({ id: schema.files.id });
    await touch(data);
    refresh();
    return row;
  });
}

export async function updateFileLinks(fileId: string, patch: z.input<typeof links>): Promise<Result> {
  return run(async () => {
    await actionUser();
    const data = links.parse(patch);
    const db = await getDb();
    await db.update(schema.files).set(data).where(eq(schema.files.id, z.uuid().parse(fileId)));
    refresh();
  });
}

/** Removes a file from the CRM. The uploader or an admin can do this. */
export async function deleteFile(fileId: string): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const db = await getDb();
    const [f] = await db.select().from(schema.files).where(eq(schema.files.id, z.uuid().parse(fileId)));
    if (!f || f.deletedAt) return;
    if (f.uploadedBy !== user.id && !isAdmin(user)) throw new ActionError("Only the person who uploaded this, or an admin, can remove it.");
    await db.update(schema.files).set({ deletedAt: new Date() }).where(eq(schema.files.id, f.id));
    if (blobConfigured()) {
      const { del } = await import("@vercel/blob");
      await del(f.url).catch((err) => console.error("[files] blob delete", err));
    }
    const entity = f.dealId ? ("deal" as const) : f.personId ? ("person" as const) : f.organizationId ? ("organization" as const) : null;
    if (entity) await recordEvent({ entityType: entity, entityId: (f.dealId ?? f.personId ?? f.organizationId)!, action: "file_deleted", data: { name: f.name }, userId: user.id });
    refresh();
  });
}
