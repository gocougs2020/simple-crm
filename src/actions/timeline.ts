"use server";

import { z } from "zod";
import { run, type Result } from "@/lib/action";
import { actionUser } from "@/lib/auth";
import { timelinePage, type TimelineItem } from "@/lib/crm/activities";

const pageInput = z.object({
  entity: z.enum(["person", "organization", "client"]),
  id: z.uuid(),
  /** The time of the oldest entry shown (ISO); without it, the newest. */
  before: z.iso.datetime({ offset: true }).optional(),
  /** How many entries the page already shows at exactly `before`. */
  skip: z.number().int().min(0).max(500).default(0),
  filter: z.enum(["all", "conversations", "tasks"]).default("all"),
  /** A page, or (after a refresh) everything that was loaded below the first page. */
  limit: z.number().int().min(1).max(1000).default(50),
});

/** More of a record's timeline, as it's scrolled or filtered. Everyone who can sign in can read records. */
export async function loadTimeline(input: z.input<typeof pageInput>): Promise<Result<{ items: TimelineItem[]; hasMore: boolean }>> {
  return run(async () => {
    const user = await actionUser();
    const o = pageInput.parse(input);
    return timelinePage(o.entity, o.id, user.id, o);
  });
}
