"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { ArrowDownLeftIcon, ArrowUpRightIcon, LockClosedIcon } from "@heroicons/react/20/solid";
import { EnvelopeIcon } from "@heroicons/react/24/outline";
import { deletePrivateEmail, setSyncedEmailVisibility, syncMyMailbox } from "@/actions/accounts";
import { deleteActivity } from "@/actions/activities";
import { useApp } from "@/components/app-context";
import { PageHeader } from "@/components/shell/app-shell";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toast";
import { formatAgo, formatDateTime } from "@/lib/format";
import { EmailTabs } from "./email-tabs";

export type OutlookRow = {
  id: string;
  /** Its entry on the record; null while it's private. */
  activityId: string | null;
  /** `public`: on the record for the team. `private`: only this teammate sees it. */
  visibility: "public" | "private";
  reason: string | null;
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
 * Email → My Outlook: the mail the sync stored from the viewer's own mailbox.
 * Each email is either on its record for the team or private to them; they
 * can switch it either way, or delete it. Their whole inbox stays in Outlook.
 */
export function OutlookList({
  account,
  rows,
  stats,
  category,
}: {
  account: { email: string; syncMail: boolean; needsReconnect: boolean; lastSyncAt: string | null } | null;
  rows: OutlookRow[];
  stats: { imported: number; private: number; withheld: number; unscreened: number } | null;
  category: string | null;
}) {
  const { workspace, canEdit } = useApp();
  const [removing, setRemoving] = useState<OutlookRow | null>(null);
  const [pending, start] = useTransition();
  const [syncing, startSync] = useTransition();
  const tz = workspace.timezone;

  return (
    <>
      <PageHeader title="Email">
        {account?.syncMail && !account.needsReconnect ? (
          <Button
            loading={syncing}
            onClick={() =>
              startSync(async () => {
                const r = await syncMyMailbox();
                if (!r.ok) return void toast.error(r.error);
                toast.success(syncSummary(r.data));
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
                Mail synced from <span className="font-medium text-primary">{account.email}</span>. Shared emails are on their records for the team; private ones are only for you, here and on the record. Only you see this list.
              </p>
              <p className="mt-1 text-[12.5px] text-muted tabular-nums">
                {account.needsReconnect
                  ? "Microsoft stopped letting the CRM in. Reconnect in Settings."
                  : !account.syncMail
                    ? "Mail sync is off, so nothing new is copied."
                    : account.lastSyncAt
                      ? `Last synced ${formatAgo(account.lastSyncAt, tz)}.`
                      : "Not synced yet."}
                {stats ? ` Last 30 days: ${stats.imported} shared, ${stats.private} private, ${stats.withheld} not stored.` : ""}
                {category && stats?.withheld ? ` Emails that weren't stored have the “${category}” category in Outlook.` : ""}{" "}
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
                          {r.visibility === "private" ? (
                            <StatusBadge icon={<LockClosedIcon className="size-3" aria-hidden />}>Private</StatusBadge>
                          ) : (
                            <StatusBadge tone="success">Shared</StatusBadge>
                          )}
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
                        {r.reason ? <p className="mt-0.5 text-[12px] text-faint">{r.reason}</p> : null}
                      </div>
                      {canEdit ? (
                        <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={pending}
                            onClick={() =>
                              start(async () => {
                                const to = r.visibility === "private" ? "public" : "private";
                                const res = await setSyncedEmailVisibility({ id: r.id, visibility: to });
                                if (!res.ok) return void toast.error(res.error);
                                toast.success(to === "public" ? "Shared with the team" : "Only you see this email now");
                              })
                            }
                          >
                            {r.visibility === "private" ? "Share with team" : "Make private"}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setRemoving(r)}>
                            Delete
                          </Button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState icon={EnvelopeIcon} title="Nothing synced yet" description="Mail with people in the CRM shows here once the sync has stored it: shared on their records, or private to you." />
            )}
            {rows.length >= 100 ? <p className="mt-3 text-center text-fine">Showing the newest 100. Older mail is on each record&apos;s timeline.</p> : null}
          </>
        )}
      </div>

      {removing ? (
        <Dialog
          open
          onOpenChange={(o) => !o && setRemoving(null)}
          title="Delete this email from the CRM?"
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
                    const r = removing.activityId ? await deleteActivity(removing.activityId) : await deletePrivateEmail(removing.id);
                    setRemoving(null);
                    if (!r.ok) return void toast.error(r.error);
                    toast.success("Email deleted");
                  })
                }
              >
                Delete
              </Button>
            </>
          }
        >
          <p className="text-[13.5px] text-secondary">{removing.visibility === "public" ? "It comes off every timeline for everyone and is never synced again." : "It's removed from the CRM and never synced again."} It stays in your Outlook.</p>
        </Dialog>
      ) : null}
    </>
  );
}

/** What a sync did, in a sentence for the toast. */
export function syncSummary(r: { imported: number; private: number; withheld: number }) {
  if (!r.imported && !r.private && !r.withheld) return "Up to date";
  return `Synced: ${r.imported} shared, ${r.private} private, ${r.withheld} not stored`;
}
