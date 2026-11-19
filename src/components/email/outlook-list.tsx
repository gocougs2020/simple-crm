"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { ArrowDownLeftIcon, ArrowUpRightIcon } from "@heroicons/react/20/solid";
import { EnvelopeIcon } from "@heroicons/react/24/outline";
import { syncMyMailbox } from "@/actions/accounts";
import { deleteActivity } from "@/actions/activities";
import { useApp } from "@/components/app-context";
import { PageHeader } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toast";
import { formatAgo, formatDateTime } from "@/lib/format";
import { EmailTabs } from "./email-tabs";

export type OutlookRow = {
  id: string;
  activityId: string;
  direction: "inbound" | "outbound";
  from: string | null;
  to: string[];
  sentAt: string;
  subject: string | null;
  snippet: string;
  record: { href: string; label: string } | null;
  person: { href: string; label: string } | null;
};

/**
 * Email → My Outlook: the mail the sync copied from the viewer's own mailbox
 * onto records, so they can see what the team sees and take back anything
 * that shouldn't be there. Their whole inbox stays in Outlook.
 */
export function OutlookList({
  account,
  rows,
  stats,
  category,
}: {
  account: { email: string; syncMail: boolean; needsReconnect: boolean; lastSyncAt: string | null } | null;
  rows: OutlookRow[];
  stats: { imported: number; withheld: number; unscreened: number } | null;
  category: string | null;
}) {
  const { workspace, canEdit } = useApp();
  const [removing, setRemoving] = useState<OutlookRow | null>(null);
  const [pending, start] = useTransition();
  const tz = workspace.timezone;

  return (
    <>
      <PageHeader title="Email">
        {account?.syncMail && !account.needsReconnect ? (
          <Button
            loading={pending && !removing}
            onClick={() =>
              start(async () => {
                const r = await syncMyMailbox();
                if (!r.ok) return void toast.error(r.error);
                toast.success(r.data.imported || r.data.withheld ? `Synced: ${r.data.imported} copied, ${r.data.withheld} kept out` : "Up to date");
              })
            }
          >
            Sync now
          </Button>
        ) : null}
      </PageHeader>
      <EmailTabs />
      <div className="mx-auto max-w-4xl px-4 py-5 lg:px-6">
        {!account ? (
          <EmptyState
            icon={EnvelopeIcon}
            title="Your Outlook isn't connected"
            description="Connect your Microsoft account to copy mail with contacts onto their records."
            action={
              <Button variant="primary" asChild>
                <Link href="/settings/accounts">Open Email and calendar settings</Link>
              </Button>
            }
          />
        ) : (
          <>
            <div className="mb-4 rounded-xl border border-line bg-surface px-4 py-3">
              <p className="text-[13.5px] text-secondary">
                Mail copied from <span className="font-medium text-primary">{account.email}</span> onto records. Only you see this list. The rest of your mailbox stays in Outlook.
              </p>
              <p className="mt-1 text-[12.5px] text-muted tabular-nums">
                {account.needsReconnect
                  ? "Microsoft stopped letting the CRM in. Reconnect in Settings."
                  : !account.syncMail
                    ? "Mail sync is off, so nothing new is copied."
                    : account.lastSyncAt
                      ? `Last synced ${formatAgo(account.lastSyncAt, tz)}.`
                      : "Not synced yet."}
                {stats ? ` Last 30 days: ${stats.imported} copied, ${stats.withheld} kept out.` : ""}
                {category && stats?.withheld ? ` Kept-out emails have the “${category}” category in Outlook.` : ""}{" "}
                <Link href="/settings/accounts" className="font-medium text-accent hover:underline">
                  Settings
                </Link>
              </p>
            </div>
            {rows.length ? (
              <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
                {rows.map((r) => {
                  const Icon = r.direction === "inbound" ? ArrowDownLeftIcon : ArrowUpRightIcon;
                  const who = r.direction === "inbound" ? `From ${r.person?.label ?? r.from ?? "someone"}` : `To ${r.person?.label ?? r.to[0] ?? "someone"}${r.to.length > 1 ? ` and ${r.to.length - 1} more` : ""}`;
                  return (
                    <li key={r.id} className="flex items-start gap-3 px-4 py-3">
                      <Icon className="mt-0.5 size-4 shrink-0 text-faint" aria-label={r.direction === "inbound" ? "Received" : "Sent"} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <p className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-primary">{r.subject || "No subject"}</p>
                          <time dateTime={r.sentAt} className="shrink-0 text-[12px] text-muted tabular-nums">
                            {formatDateTime(r.sentAt, tz)}
                          </time>
                        </div>
                        <p className="truncate text-[12.5px] text-secondary">
                          {who}
                          {r.record ? (
                            <>
                              {" · on "}
                              <Link href={r.record.href} className="font-medium text-accent hover:underline">
                                {r.record.label}
                              </Link>
                            </>
                          ) : null}
                        </p>
                        {r.snippet ? <p className="mt-0.5 line-clamp-2 text-[12.5px] text-muted">{r.snippet}</p> : null}
                      </div>
                      {canEdit ? (
                        <Button size="sm" variant="ghost" onClick={() => setRemoving(r)}>
                          Remove
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState icon={EnvelopeIcon} title="Nothing copied yet" description="Mail to and from people and organizations in the CRM shows here once the sync has copied it onto their records." />
            )}
            {rows.length >= 100 ? <p className="mt-3 text-center text-fine">Showing the newest 100. Older mail is on each record&apos;s timeline.</p> : null}
          </>
        )}
      </div>

      {removing ? (
        <Dialog
          open
          onOpenChange={(o) => !o && setRemoving(null)}
          title="Remove this email from records?"
          description={removing.subject || "No subject"}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setRemoving(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={pending}
                onClick={() =>
                  start(async () => {
                    const r = await deleteActivity(removing.activityId);
                    setRemoving(null);
                    if (!r.ok) return void toast.error(r.error);
                    toast.success("Removed from records");
                  })
                }
              >
                Remove
              </Button>
            </>
          }
        >
          <p className="text-[13.5px] text-secondary">It comes off every timeline for everyone and is never copied again. It stays in your Outlook.</p>
        </Dialog>
      ) : null}
    </>
  );
}
