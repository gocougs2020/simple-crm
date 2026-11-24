/**
 * Where a teammate who hasn't set a password stands: a link that still works
 * ("sent"), one that ran out ("expired"), or none yet ("none", e.g. someone the
 * Pipedrive import added). Null once they've joined.
 */
export type InviteState = { state: "sent" | "expired" | "none"; expiresAt: Date | null } | null;

/** A teammate's invite state from whether they've joined and when their latest unused invite link expires. */
export function inviteState(joined: boolean, latestExpiry: Date | null, now = new Date()): InviteState {
  if (joined) return null;
  if (!latestExpiry) return { state: "none", expiresAt: null };
  return { state: latestExpiry > now ? "sent" : "expired", expiresAt: latestExpiry };
}
