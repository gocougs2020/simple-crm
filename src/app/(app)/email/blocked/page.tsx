import type { Metadata } from "next";
import { Suspense } from "react";
import { BlockList } from "@/components/email/block-list";
import { PageSkeleton } from "@/components/ui/skeleton";
import { requireUser } from "@/lib/auth";
import { microsoftConfigured } from "@/lib/microsoft/config";
import { accountOf } from "@/lib/microsoft/graph";

export const metadata: Metadata = { title: "Block list" };

export default function BlockedPage() {
  return (
    <Suspense fallback={<PageSkeleton rows={4} />}>
      <Blocked />
    </Suspense>
  );
}

/** The signed-in teammate's own block list, the same one Settings → Email and calendar edits. Always their account, from the session. */
async function Blocked() {
  const user = await requireUser("/email/blocked");
  const account = microsoftConfigured() ? await accountOf(user.id) : null;
  return <BlockList account={account ? { email: account.email, blocked: account.blocked } : null} />;
}
