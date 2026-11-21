import "server-only";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { after } from "next/server";
import { generateText, Output, type UserContent } from "ai";
import { z } from "zod";
import { appConfig } from "@/app.config";
import { getDb, schema } from "@/db";
import { aiFeatures } from "@/lib/agent/config";
import { aiGateway } from "@/lib/agent/gateway";
import { readStoredBytes } from "@/lib/file-bytes";
import { cleanModelText, DESCRIBE_BYTES_MAX, describeInstructions, describeKind, DESCRIPTION_MAX, fileTextBlock, NOTES_MAX } from "@/lib/file-describe-rules";
import { embedBacklog, embedFile } from "@/lib/file-search";
import { fileText } from "@/lib/file-text";

/**
 * Short descriptions of uploaded files, so the agent can find them. When a
 * file is uploaded (on Files, a record, or in the team chat), a small model
 * (`agent.fileModel`) reads what it can of it and writes a description and
 * the key facts, stored on the file. The model has no tools and answers in a
 * fixed shape: a file can only change the text stored about itself. A
 * teammate can rewrite the description; the model never overwrites theirs.
 */

const { files } = schema;
const CLAIM_MS = 5 * 60_000;

const answer = z.object({
  description: z.string().describe("One or two plain sentences: what the file is and what it's for."),
  notes: z.string().describe("The facts, figures and terms in the file, as short plain lines. Empty when there are none."),
});

/** Describes one file now. Quietly does nothing when it's off, already described, written by hand, or being described elsewhere. */
export async function describeFile(fileId: string, opts: { again?: boolean } = {}) {
  if (!aiFeatures().files) return;
  const db = await getDb();
  const now = new Date();
  const [f] = await db
    .update(files)
    // Marked failed up front: if reading the file takes the worker down, the backlog doesn't pick it up again.
    .set({ describeStartedAt: now, describeStatus: "failed" })
    .where(
      and(
        eq(files.id, fileId),
        isNull(files.deletedAt),
        isNull(files.descriptionBy),
        opts.again ? undefined : isNull(files.describeStatus),
        or(isNull(files.describeStartedAt), lt(files.describeStartedAt, new Date(now.getTime() - CLAIM_MS))),
      ),
    )
    .returning();
  if (!f) return;
  const finish = (set: Partial<typeof files.$inferInsert>) =>
    db
      .update(files)
      .set({ ...set, describedAt: new Date(), describeStartedAt: null })
      .where(and(eq(files.id, f.id), isNull(files.descriptionBy)));

  const kind = describeKind(f.name, f.contentType);
  if (!kind || ((kind === "pdf" || kind === "image") && f.size > DESCRIBE_BYTES_MAX)) return void (await finish({ describeStatus: "skipped" }));
  try {
    const bytes = await readStoredBytes(f);
    const content: UserContent = [{ type: "text", text: `Describe this file. Its name is "${f.name.replace(/"/g, "'")}" (${f.contentType || "unknown type"}).` }];
    if (kind === "pdf") content.push({ type: "file", mediaType: "application/pdf", data: bytes, filename: f.name });
    else if (kind === "image") content.push({ type: "file", mediaType: f.contentType, data: bytes });
    else {
      const text = await fileText(bytes, kind);
      if (!text?.trim()) return void (await finish({ describeStatus: "skipped" }));
      content.push({ type: "text", text: fileTextBlock(f.name, text) });
    }
    const { output } = await generateText({
      model: aiGateway(appConfig.agent.fileModel),
      reasoning: appConfig.agent.fileReasoning,
      system: describeInstructions,
      messages: [{ role: "user", content }],
      output: Output.object({ schema: answer }),
      // Reasoning counts toward this; the description itself is short.
      maxOutputTokens: 3_000,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(90_000),
    });
    const description = cleanModelText(output?.description, DESCRIPTION_MAX);
    await finish({ describeStatus: description ? "done" : "failed", description: description || null, contentNotes: cleanModelText(output?.notes, NOTES_MAX, { lines: true }) || null });
    if (description) await embedFile(f.id).catch((err) => console.error("[files] embed", f.id, err));
  } catch (err) {
    console.error("[files] describe", f.id, err);
    await finish({ describeStatus: "failed" });
  }
}

/** Describes a file after the response is sent, so uploading never waits on the model. */
export function describeSoon(fileId: string) {
  if (!aiFeatures().files) return;
  const work = () => describeFile(fileId).catch((err) => console.error("[files] describe", err));
  try {
    after(work);
  } catch {
    void work();
  }
}

/**
 * Files nobody has described yet (uploaded before this existed, or whose
 * describe was cut off), newest first. The agent cron calls this, a few at a
 * time, so a big backlog spreads over the day.
 */
export async function describeBacklog(limit = 15) {
  if (!aiFeatures().files) return { described: 0, embedded: 0 };
  const db = await getDb();
  const rows = await db
    .select({ id: files.id })
    .from(files)
    .where(and(isNull(files.deletedAt), isNull(files.describeStatus), isNull(files.descriptionBy), or(isNull(files.describeStartedAt), lt(files.describeStartedAt, sql`now() - interval '5 minutes'`))))
    .orderBy(desc(files.createdAt))
    .limit(limit);
  // One file failing doesn't stop the rest.
  for (const r of rows) await describeFile(r.id).catch((err) => console.error("[files] describe", r.id, err));
  const { embedded } = await embedBacklog();
  return { described: rows.length, embedded };
}
