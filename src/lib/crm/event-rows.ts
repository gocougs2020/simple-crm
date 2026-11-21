import type { EntityType } from "@/lib/constants";

/** One history entry, as the service layer describes it. */
export type EventInput = { entityType: EntityType; entityId: string; action: string; data?: Record<string, unknown>; userId: string | null; apiKeyId?: string | null };

/** The row a history entry is written as: one place, so `recordEvent` and `recordEvents` write the same thing. */
export const eventRow = (input: EventInput) => ({ ...input, data: input.data ?? {} });

/** Rows in groups of `size`, so one insert stays well under Postgres' 65,535 bound parameters. */
export function inChunks<T>(rows: T[], size = 1000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}
