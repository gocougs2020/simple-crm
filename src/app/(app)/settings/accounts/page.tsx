import type { Metadata } from "next";
import { Suspense } from "react";
import { AccountSettings } from "@/components/settings/accounts";
import { PageSkeleton } from "@/components/ui/skeleton";
import { requireUser } from "@/lib/auth";
import { microsoftConfigured, syncEveryMinutes, withheldCategory } from "@/lib/microsoft/config";
import { accountOf } from "@/lib/microsoft/graph";
import { mailboxStats, teamConnections } from "@/lib/microsoft/mail";
import { screeningOn } from "@/lib/microsoft/screen";
import { aiGatewayAvailable } from "@/lib/agent/config";

export const metadata: Metadata = { title: "Email and calendar" };

export default function AccountsPage({ searchParams }: PageProps<"/settings/accounts">) {
  return (
    <Suspense fallback={<PageSkeleton rows={4} />}>
      <Accounts searchParams={searchParams} />
    </Suspense>
  );
}

async function Accounts({ searchParams }: Pick<PageProps<"/settings/accounts">, "searchParams">) {
  const user = await requireUser("/settings/accounts");
  const params = await searchParams;
  const configured = microsoftConfigured();
  const account = configured ? await accountOf(user.id) : null;
  const stats = account ? await mailboxStats(account.id) : null;
  // Owners see who's connected and can cut a connection; nothing of anyone's mail.
  const team = configured && user.role === "owner" ? await teamConnections() : null;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;
  return (
    <AccountSettings
      configured={configured}
      // Never the tokens: only what the settings show.
      account={
        account
          ? {
              email: account.email,
              name: account.name,
              sendMail: account.sendMail,
              syncMail: account.syncMail,
              syncCalendar: account.syncCalendar,
              calendarSharing: account.calendarSharing,
              blocked: account.blocked,
              mailFolders: account.mailFolders,
              status: account.status,
              lastSyncAt: account.lastSyncAt?.toISOString() ?? null,
              lastError: account.lastError,
            }
          : null
      }
      stats={stats}
      team={team ? team.filter((c) => c.userId !== user.id).map((c) => ({ ...c, lastSyncAt: c.lastSyncAt?.toISOString() ?? null })) : null}
      sync={{ everyMinutes: syncEveryMinutes(), screening: screeningOn(), screenReady: aiGatewayAvailable(), category: withheldCategory() }}
      notice={{ connected: one(params.connected), error: one(params.error) }}
    />
  );
}
