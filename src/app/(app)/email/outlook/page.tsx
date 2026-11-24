import type { Metadata } from "next";
import { Suspense } from "react";
import { OutlookList } from "@/components/email/outlook-list";
import { PageSkeleton } from "@/components/ui/skeleton";
import { requireUser } from "@/lib/auth";
import { microsoftConfigured, withheldCategory } from "@/lib/microsoft/config";
import { accountOf } from "@/lib/microsoft/graph";
import { copiedMail, mailboxStats } from "@/lib/microsoft/mail";
import { htmlToText } from "@/lib/safe-html";
import { appConfig } from "@/app.config";
import { blockChoices, internalDomains, isBlocked } from "@/lib/microsoft/sync-rules";

export const metadata: Metadata = { title: "My Outlook" };

export default function OutlookPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Outlook />
    </Suspense>
  );
}

/**
 * What the sync stored from the signed-in teammate's own mailbox: on records
 * for the team, or private to them. The account
 * is always looked up from the session, never from the URL, so there's no way
 * to open someone else's list, owner or not.
 */
async function Outlook() {
  const user = await requireUser("/email/outlook");
  const account = microsoftConfigured() ? await accountOf(user.id) : null;
  if (!account) return <OutlookList account={null} rows={[]} stats={null} category={null} />;
  const [rows, stats] = await Promise.all([copiedMail(account.id), mailboxStats(account.id)]);
  // What deleting a received email can block: never our own mailbox or domain.
  const ours = { emails: [account.email, user.email], domains: [...internalDomains([account.email], appConfig.microsoft.internalDomains)] };
  // The linked person is whoever on the email is in the CRM, not always who sent it: name them only when the address is theirs.
  const theirs = (r: (typeof rows)[number], address: string | undefined | null) => !!address && [r.personEmail, ...(r.personOtherEmails ?? [])].some((e) => e?.toLowerCase() === address.toLowerCase());
  return (
    <OutlookList
      account={{ email: account.email, syncMail: account.syncMail, needsReconnect: account.status !== "active", lastSyncAt: account.lastSyncAt?.toISOString() ?? null, blocked: account.blocked.length }}
      rows={rows.map((r) => ({
        id: r.id,
        activityId: r.activityId,
        visibility: r.status === "private" ? ("private" as const) : ("public" as const),
        // Why the screen kept it private, in its own words.
        reason: r.status === "private" ? r.reason : null,
        direction: r.direction,
        from: r.from,
        to: r.to,
        name: r.personName && theirs(r, r.direction === "inbound" ? r.from : r.to[0]) ? r.personName : null,
        sentAt: r.sentAt.toISOString(),
        subject: r.subject,
        snippet: htmlToText(r.body).slice(0, 240),
        // The whole email for the reading pane, as text. The sync already left out the quoted thread below it.
        body: htmlToText(r.body).slice(0, 20_000),
        block: r.direction === "inbound" ? blockChoices(r.from, ours) : null,
        blocked: !!r.from && r.direction === "inbound" && isBlocked([r.from], account.blocked),
        record: r.clientId
          ? { href: `/clients/${r.clientId}`, label: r.clientName ?? "A client" }
          : r.personId
            ? { href: `/people/${r.personId}`, label: r.personName ?? "Someone" }
            : r.organizationId
              ? { href: `/organizations/${r.organizationId}`, label: r.organizationName ?? "An organization" }
              : null,
        person: r.personId ? { href: `/people/${r.personId}`, label: r.personName ?? "Someone" } : null,
      }))}
      stats={stats}
      category={withheldCategory()}
    />
  );
}
