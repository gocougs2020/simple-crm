"use client";

import { useEffect, useState, useTransition } from "react";
import { disconnectMicrosoft, syncMyMailbox, updateMicrosoftAccount } from "@/actions/accounts";
import { useApp } from "@/components/app-context";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, Select } from "@/components/ui/field";
import { Dialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { appConfig } from "@/app.config";
import { calendarSharingLabels, calendarSharings, type CalendarSharing } from "@/lib/constants";
import { formatAgo } from "@/lib/format";
import { Section } from "./nav";

type Account = {
  email: string;
  name: string | null;
  sendMail: boolean;
  syncMail: boolean;
  syncCalendar: boolean;
  calendarSharing: CalendarSharing;
  status: "active" | "reconnect";
  lastSyncAt: string | null;
  lastError: string | null;
};

/**
 * Settings → Email and calendar: a teammate connects their own Microsoft 365
 * mailbox and calendar, and chooses what the CRM does with them.
 */
export function AccountSettings({
  configured,
  account,
  stats,
  sync,
  notice,
}: {
  configured: boolean;
  account: Account | null;
  stats: { imported: number; withheld: number; pending: number } | null;
  sync: { everyMinutes: number; screening: boolean; screenReady: boolean; category: string | null };
  notice: { connected: string | null; error: string | null };
}) {
  const { viewer, workspace } = useApp();
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (notice.connected) toast.success(`Connected ${notice.connected}`);
    if (notice.error) toast.error(notice.error);
    if (notice.connected || notice.error) window.history.replaceState(null, "", "/settings/accounts");
  }, [notice.connected, notice.error]);

  const set = (patch: Parameters<typeof updateMicrosoftAccount>[0]) =>
    start(async () => {
      const r = await updateMicrosoftAccount(patch);
      if (!r.ok) toast.error(r.error);
    });

  if (!configured) {
    return (
      <Section title="Microsoft 365" description="Send email from your own Outlook address, copy mail with contacts onto their records, and put CRM meetings on your calendar.">
        <p className="p-5 text-[13.5px] text-muted">
          Microsoft 365 isn&apos;t set up on this deployment. An admin can register the CRM in Microsoft Entra ID and add MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET (see docs/MICROSOFT.md).
        </p>
      </Section>
    );
  }

  return (
    <>
      <Section
        title="Microsoft 365"
        description="Connect your Outlook (Microsoft 365 or Exchange Online) to send email as yourself, bring mail with contacts onto their records, and keep CRM meetings on your calendar. Only you can connect or disconnect it."
      >
        {!account ? (
          <div className="flex flex-wrap items-center gap-4 p-5">
            <p className="min-w-0 flex-1 text-[13.5px] text-secondary">Microsoft asks you to sign in and approve access to your mail and calendar. Your organization&apos;s admin may need to approve the app first.</p>
            <Button variant="primary" asChild>
              <a href={`/api/integrations/microsoft/connect?hint=${encodeURIComponent(viewer.email)}`}>Connect Microsoft account</a>
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-line">
            <div className="flex flex-wrap items-center gap-3 p-5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium text-primary">{account.email}</p>
                <p className="text-[12.5px] text-muted">
                  {account.status === "reconnect" ? "Microsoft stopped letting the CRM in." : account.lastSyncAt ? `Last synced ${formatAgo(account.lastSyncAt, workspace.timezone)}` : "Not synced yet"}
                </p>
              </div>
              {account.status === "reconnect" ? <StatusBadge tone="error">Needs reconnecting</StatusBadge> : <StatusBadge tone="success">Connected</StatusBadge>}
              <Button variant={account.status === "reconnect" ? "primary" : "ghost"} size="sm" asChild>
                <a href={`/api/integrations/microsoft/connect?hint=${encodeURIComponent(account.email)}`}>Reconnect</a>
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirm(true)}>
                Disconnect
              </Button>
            </div>
            {account.lastError ? <p className="bg-warning-surface px-5 py-2.5 text-[13px] text-warning">{account.lastError}</p> : null}
            <div className="flex flex-col gap-3 p-5">
              <Checkbox checked={account.sendMail} onChange={(e) => set({ sendMail: e.target.checked })} label={<span className="text-[13.5px]">Send email from records through my mailbox</span>} />
              <p className="-mt-2 pl-6 text-fine">It goes out as you, is saved in your Sent Items, and replies come back to your Outlook. You can still pick the CRM&apos;s address when writing an email.</p>
              <Checkbox checked={account.syncMail} onChange={(e) => set({ syncMail: e.target.checked })} label={<span className="text-[13.5px]">Copy mail with contacts onto their records</span>} />
              <p className="-mt-2 pl-6 text-fine">
                Every {sync.everyMinutes} minutes, mail to and from people and organizations in the CRM is added to their timelines. Mail with teammates and with anyone not in the CRM is left alone.
                {appConfig.microsoft.syncSent ? " Mail you send from Outlook is included." : ""}
              </p>
              <Checkbox checked={account.syncCalendar} onChange={(e) => set({ syncCalendar: e.target.checked })} label={<span className="text-[13.5px]">Put meetings assigned to me on my calendar, and show it in Calendar</span>} />
            </div>
            {account.syncMail ? (
              <div className="p-5">
                <p className="text-[13px] font-medium text-primary">Private and confidential mail</p>
                <p className="mt-0.5 text-[13px] text-muted">
                  Emails marked Private or Confidential in Outlook are never copied.
                  {sync.screening
                    ? sync.screenReady
                      ? " Each other email is also read by an AI screen first, and anything that looks personal or confidential stays out."
                      : " The AI screen isn't set up yet (it needs an AI Gateway key), so mail waits until it is."
                    : ""}
                  {sync.category ? ` Kept-out emails get the “${sync.category}” category in Outlook, so you can see which ones.` : ""} If something private slips through, delete it from the timeline.
                </p>
                {stats ? (
                  <p className="mt-2 text-[12.5px] text-secondary tabular-nums">
                    Last 30 days: {stats.imported} copied · {stats.withheld} kept out{stats.pending ? ` · ${stats.pending} waiting` : ""}
                  </p>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  loading={pending}
                  disabled={account.status === "reconnect"}
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
              </div>
            ) : null}
          </div>
        )}
      </Section>

      {account?.syncCalendar ? (
        <Section title="Calendar sharing" description="What teammates see of your Outlook calendar in Calendar. CRM meetings and calls are records, so the team sees those either way.">
          <div className="flex flex-col gap-2 p-5">
            <Select aria-label="Calendar sharing" value={account.calendarSharing} onChange={(e) => set({ calendarSharing: e.target.value as CalendarSharing })} className="max-w-xs">
              {calendarSharings.map((s) => (
                <option key={s} value={s}>
                  {calendarSharingLabels[s].label}
                </option>
              ))}
            </Select>
            <p className="text-fine">{calendarSharingLabels[account.calendarSharing].hint} Events you mark Private in Outlook always show as busy.</p>
          </div>
        </Section>
      ) : null}

      {confirm ? (
        <Dialog
          open
          onOpenChange={(o) => !o && setConfirm(false)}
          title="Disconnect Microsoft?"
          description="The CRM forgets its access to your mailbox and calendar right away. Meetings it put on your calendar stay there."
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                Cancel
              </Button>
              <Button
                variant="outline"
                loading={pending}
                onClick={() =>
                  start(async () => {
                    const r = await disconnectMicrosoft({ removeMail: true });
                    setConfirm(false);
                    if (!r.ok) return void toast.error(r.error);
                    toast.success("Disconnected, and the copied mail removed");
                  })
                }
              >
                Disconnect and remove copied mail
              </Button>
              <Button
                variant="primary"
                loading={pending}
                onClick={() =>
                  start(async () => {
                    const r = await disconnectMicrosoft();
                    setConfirm(false);
                    if (!r.ok) return void toast.error(r.error);
                    toast.success("Disconnected");
                  })
                }
              >
                Disconnect
              </Button>
            </>
          }
        >
          <p className="text-[13.5px] text-secondary">Mail already copied to records stays on their timelines unless you remove it. To revoke the app entirely, remove it from your Microsoft account&apos;s apps page too.</p>
        </Dialog>
      ) : null}
    </>
  );
}
