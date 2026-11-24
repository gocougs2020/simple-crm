import { StatusBadge } from "@/components/ui/badge";
import type { InviteState } from "@/lib/invite-state";

/** Whether a teammate can sign in, and if they haven't joined, whether an invite is actually waiting for them. Nothing once they've joined. */
export function TeammateStatus({ deactivated, invite }: { deactivated: boolean; invite: InviteState }) {
  if (deactivated) return <StatusBadge>Deactivated</StatusBadge>;
  if (!invite) return null;
  if (invite.state === "sent") return <StatusBadge tone="warning">Invite sent</StatusBadge>;
  if (invite.state === "expired") return <StatusBadge tone="error">Invite expired</StatusBadge>;
  return <StatusBadge>Not invited</StatusBadge>;
}
