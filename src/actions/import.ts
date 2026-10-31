"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { run, type Result } from "@/lib/action";
import { actionUser } from "@/lib/auth";
import { importRows, undoImport } from "@/lib/crm/import";
import type { ImportChunkResult } from "@/lib/crm/import-fields";

export async function startImport(fileName: string): Promise<Result<{ id: string }>> {
  return run(async () => {
    const user = await actionUser();
    const db = await getDb();
    const [row] = await db
      .insert(schema.peopleImports)
      .values({ fileName: z.string().max(200).parse(fileName) || "Spreadsheet", userId: user.id })
      .returning({ id: schema.peopleImports.id });
    return row;
  });
}

const s = (max: number) => z.string().max(max).optional();
const rowSchema = z.object({
  row: z.number().int(),
  firstName: s(200),
  lastName: s(200),
  email: s(320),
  phone: s(80),
  title: s(300),
  organization: s(300),
  tags: z.array(z.string().max(40)).max(30).optional(),
  notes: s(10_000),
  marketingOptIn: z.boolean().optional(),
});

export async function importChunk(importId: string, rows: unknown, defaults: { ownerId: string | null; marketingOptIn: boolean }): Promise<Result<ImportChunkResult>> {
  return run(async () => {
    const user = await actionUser();
    const list = z.array(rowSchema).max(250).parse(rows);
    const d = z.object({ ownerId: z.uuid().nullable(), marketingOptIn: z.boolean() }).parse(defaults);
    return importRows(z.uuid().parse(importId), list, d, user.id);
  });
}

export async function finishImport(): Promise<Result> {
  return run(async () => {
    await actionUser();
    refresh();
  });
}

export async function undoPeopleImport(importId: string): Promise<Result<{ removed: number; restored: number }>> {
  return run(async () => {
    await actionUser();
    const r = await undoImport(z.uuid().parse(importId));
    refresh();
    return r;
  });
}
