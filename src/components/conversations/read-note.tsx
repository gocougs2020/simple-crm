"use client";

import { useApp } from "@/components/app-context";
import type { ReadState } from "@/lib/conversations/read-rules";

/**
 * Says whose unread a conversation is, when it isn't the viewer's to change
 * (src/lib/conversations/read-rules.ts). Nothing when it's theirs or nobody's.
 */
export function ReadNote({ state, read }: { state: ReadState; read: boolean }) {
  const { member } = useApp();
  if (state.canChange) return null;
  const owner = member(state.ownerId)?.name ?? "Its owner";
  return (
    <p className="text-[12px] text-muted">
      {read ? `${owner} owns this record, so read and unread are up to them.` : `Unread for ${owner}, who owns this record. Opening it doesn't change that for them.`}
    </p>
  );
}
