"use client";

import { useEffect, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import { disconnectMicrosoft, disconnectTeammateMicrosoft, myMailFolders, syncMyMailbox, updateEmailSignature, updateMicrosoftAccount } from "@/actions/accounts";
import { syncSummary } from "@/components/email/outlook-list";
import { useApp } from "@/components/app-context";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, Select, Textarea } from "@/components/ui/field";
import { Dialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
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
  blocked: string[];
  mailFolders: { id: string; name: string }[] | null;
  status: "active" | "reconnect";
  lastSyncAt: string | null;
  lastError: string | null;
};

/** Tiptap loads only when this page opens, like the other text boxes (src/components/ui/rich-text.tsx). */
const SignatureEditor = dynamic(() => import("./signature-editor").then((m) => m.SignatureEditor), {
  ssr: false,
  loading: () => <div className="h-[154px] rounded-lg border border-line bg-surface" />,
});

type Signature = { html: string; auto: boolean; workspace: boolean };

type Connection = {
  userId: string;
  userName: string;
  deactivated: boolean;
  email: string;
  sendMail: boolean;
  syncMail: boolean;
  syncCalendar: boolean;
  status: "active" | "reconnect";
  lastSyncAt: string | null;
};

/**
 * Settings → Email and calendar: a teammate connects their own Microsoft 365
 * mailbox and calendar, and chooses what the CRM does with them.
 */
export function AccountSettings({
  configured,
  account,
  stats,
  team,
  signature,
  sync,
  notice,
}: {
  configured: boolean;
  account: Account | null;
  stats: { imported: number; private: number; withheld: number; unscreened: number } | null;
  /** Everyone else's connections, for owners only; null for everybody else. */
  team: Connection[] | null;
  /** Their own email signature, and whether the workspace has one to fall back on. */
  signature: Signature;
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
        description="Connect your Outlook (Microsoft 365 or Exchange Online) to send email as yourself, bring mail with contacts onto their records, and keep CRM meetings on your calendar. Only you can connect it. You can disconnect it any time, and so can an owner."
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
              <Checkbox checked={account.syncMail} onChange={(e) => set({ syncMail: e.target.checked })} label={<span className="text-[13.5px]">Sync mail with contacts onto their records</span>} />
              <p className="-mt-2 pl-6 text-fine">
                Every {sync.everyMinutes} minutes, mail with people in the CRM is synced: anything where someone on the From, To or Cc line is a person here and isn&apos;t one of your own organization&apos;s addresses. Mail only between colleagues, and with anyone not in the CRM, is left alone.
              </p>
              <Checkbox checked={account.syncCalendar} onChange={(e) => set({ syncCalendar: e.target.checked })} label={<span className="text-[13.5px]">Put meetings assigned to me on my calendar, and show it in Calendar</span>} />
            </div>
            {account.syncMail ? (
              <div className="p-5">
                <p className="text-[13px] font-medium text-primary">Private and confidential mail</p>
                <p className="mt-0.5 text-[13px] text-muted">
                  Emails marked Private or Confidential in Outlook are never stored.
                  {sync.screening
                    ? sync.screenReady
                      ? " Every other email is checked first by an AI screen. When it's fairly sure there's nothing sensitive, the email goes on the record for the team. When it isn't sure, the email is kept private: only you see it, here and on the record, until you share it. When it's very sure the email is sensitive, it isn't stored at all."
                      : " The AI screen isn't set up on this deployment (it needs an AI Gateway key), so every email is kept private to you until you share it."
                    : " Screening is off on this deployment, so every other email goes on the record for the team."}
                  {sync.category ? ` Emails that weren't stored get the “${sync.category}” category in Outlook, so you can see which ones.` : ""} You can make any email private, share it or delete it in{" "}
                  <a href="/email/outlook" className="font-medium text-accent hover:underline">
                    Email → My Outlook
                  </a>
                  .
                </p>
                {stats ? (
                  <p className="mt-2 text-[12.5px] text-secondary tabular-nums">
                    Last 30 days: {stats.imported} shared · {stats.private} private · {stats.withheld} not stored{stats.unscreened ? ` · ${stats.unscreened} private because the screen didn't answer` : ""}
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
                      toast.success(syncSummary(r.data));
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

      <SignatureSettings key={`${signature.html}|${signature.auto}`} signature={signature} connected={!!account} />

      {account?.syncMail ? <SyncControls key={`${account.blocked.join()}|${(account.mailFolders ?? []).map((f) => f.id).join()}`} account={account} /> : null}

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

      {team ? <TeamConnections rows={team} /> : null}

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

/**
 * Owners only: every teammate's connected mailbox and calendar, and a way to
 * cut one. It shows that a connection exists and what it's used for, never
 * the mail or the calendar itself.
 */
function TeamConnections({ rows }: { rows: Connection[] }) {
  const { workspace } = useApp();
  const [target, setTarget] = useState<Connection | null>(null);
  const [pending, start] = useTransition();
  const cut = (removeMail: boolean) =>
    start(async () => {
      if (!target) return;
      const r = await disconnectTeammateMicrosoft({ userId: target.userId, removeMail });
      setTarget(null);
      if (!r.ok) return void toast.error(r.error);
      toast.success(removeMail ? `Disconnected ${target.userName}, and the copied mail removed` : `Disconnected ${target.userName}`);
    });
  return (
    <>
      <Section
        title="Team connections"
        description="Teammates who connected their Microsoft account. As an owner you can disconnect one if you need to, for example when someone leaves. You can't read their mailbox, and only they can connect it again."
      >
        {rows.length ? (
          <ul className="divide-y divide-line">
            {rows.map((c) => {
              const uses = [c.sendMail ? "sends email" : "", c.syncMail ? "copies mail to records" : "", c.syncCalendar ? "calendar" : ""].filter(Boolean).join(", ");
              return (
                <li key={c.userId} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-medium text-primary">
                      {c.userName}
                      {c.deactivated ? <span className="ml-2 text-[12.5px] font-normal text-muted">Deactivated</span> : null}
                    </p>
                    <p className="truncate text-[12.5px] text-muted">
                      {c.email} · {uses || "nothing turned on"}
                      {c.syncMail ? ` · ${c.lastSyncAt ? `last synced ${formatAgo(c.lastSyncAt, workspace.timezone)}` : "not synced yet"}` : ""}
                    </p>
                  </div>
                  {c.status === "reconnect" ? <StatusBadge tone="error">Needs reconnecting</StatusBadge> : c.deactivated ? <StatusBadge>Paused</StatusBadge> : <StatusBadge tone="success">Connected</StatusBadge>}
                  <Button variant="ghost" size="sm" onClick={() => setTarget(c)}>
                    Disconnect
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="p-5 text-[13.5px] text-muted">Nobody else has connected a Microsoft account yet. Each teammate connects their own from this page.</p>
        )}
      </Section>

      {target ? (
        <Dialog
          open
          onOpenChange={(o) => !o && setTarget(null)}
          title={`Disconnect ${target.userName}?`}
          description={`The CRM forgets its access to ${target.email} right away: no more mail is copied, email from records stops going out through it, and their Outlook calendar leaves Calendar.`}
          size="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setTarget(null)}>
                Cancel
              </Button>
              <Button variant="outline" loading={pending} onClick={() => cut(true)}>
                Disconnect and remove copied mail
              </Button>
              <Button variant="primary" loading={pending} onClick={() => cut(false)}>
                Disconnect
              </Button>
            </>
          }
        >
          <p className="text-[13.5px] text-secondary">Mail already copied to records stays on their timelines unless you remove it. {target.userName} can connect again from their own settings.</p>
        </Dialog>
      ) : null}
    </>
  );
}

/**
 * What the teammate's own sync reads: which folders, and whose mail never to
 * take. Both are theirs alone to set.
 */
function SyncControls({ account }: { account: Account }) {
  const [pending, start] = useTransition();
  const [blocked, setBlocked] = useState(account.blocked.join("\n"));
  const [custom, setCustom] = useState(!!account.mailFolders?.length);
  const [picked, setPicked] = useState<{ id: string; name: string }[]>(account.mailFolders ?? []);
  const [folders, setFolders] = useState<{ id: string; name: string }[] | null>(null);
  const [loading, startLoading] = useTransition();

  const load = () =>
    startLoading(async () => {
      const r = await myMailFolders();
      if (!r.ok) return void toast.error(r.error);
      setFolders(r.data);
    });
  const save = (patch: Parameters<typeof updateMicrosoftAccount>[0], done: string) =>
    start(async () => {
      const r = await updateMicrosoftAccount(patch);
      if (!r.ok) return void toast.error(r.error);
      toast.success(done);
    });
  // Folders already picked show before the list loads from Outlook, and stay if one was since renamed there.
  const options = folders ? [...folders, ...picked.filter((p) => !folders.some((f) => f.id === p.id))] : picked;
  const foldersChanged = custom ? picked.map((f) => f.id).join() !== (account.mailFolders ?? []).map((f) => f.id).join() : !!account.mailFolders?.length;

  return (
    <>
      <Section title="Folders to sync" description="By default the CRM reads your Inbox and Sent Items. Pick your own folders instead and only mail you keep or move there is synced, however old it is.">
        <div className="flex flex-col gap-3 p-5">
          <label className="flex cursor-pointer items-center gap-2 text-[13.5px]">
            <input type="radio" name="folders" className="size-4 accent-[var(--accent)]" checked={!custom} onChange={() => setCustom(false)} />
            Inbox and Sent Items
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-[13.5px]">
            <input
              type="radio"
              name="folders"
              className="size-4 accent-[var(--accent)]"
              checked={custom}
              onChange={() => {
                setCustom(true);
                if (!folders) load();
              }}
            />
            Only the folders I pick
          </label>
          {custom ? (
            <div className="ml-6 flex flex-col gap-2">
              {options.map((f) => (
                <Checkbox
                  key={f.id}
                  checked={picked.some((p) => p.id === f.id)}
                  onChange={(e) => setPicked((now) => (e.target.checked ? [...now, f] : now.filter((p) => p.id !== f.id)))}
                  label={<span className="text-[13.5px]">{f.name}</span>}
                />
              ))}
              {loading ? <p className="text-fine">Reading your folders from Outlook…</p> : null}
              {!folders && !loading ? (
                <Button size="sm" variant="ghost" className="self-start" onClick={load}>
                  Show all my folders
                </Button>
              ) : null}
              {folders && !options.length ? <p className="text-fine">Outlook didn&apos;t return any folders.</p> : null}
              <p className="text-fine">A folder you pick is read from the start the first time, so everything already in it is looked at.</p>
            </div>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            loading={pending}
            disabled={!foldersChanged || (custom && !picked.length)}
            onClick={() => save({ mailFolders: custom ? picked : null }, custom ? "Syncing the folders you picked" : "Syncing Inbox and Sent Items")}
          >
            Save folders
          </Button>
        </div>
      </Section>

      <Section title="Never sync" description="Addresses and domains whose mail is never synced from your mailbox, whoever else is on the email. Mail already synced stays until you delete it.">
        <div className="flex flex-col gap-2 p-5">
          <Textarea aria-label="Addresses and domains to never sync" rows={4} value={blocked} onChange={(e) => setBlocked(e.target.value)} placeholder={"jo@acme.com\nlawfirm.com"} className="max-w-md font-mono text-[13px]" />
          <p className="text-fine">One per line. A domain like lawfirm.com covers everyone there.</p>
          <Button size="sm" variant="outline" className="self-start" loading={pending} disabled={blocked.trim() === account.blocked.join("\n")} onClick={() => save({ blocked }, "Block list saved")}>
            Save block list
          </Button>
        </div>
      </Section>
    </>
  );
}

/**
 * The teammate's own email signature, for email they send from their Outlook:
 * written in a rich editor, and set to go on every email or only when they
 * add it. The composer lets them add or take it off each email either way.
 */
function SignatureSettings({ signature, connected }: { signature: Signature; connected: boolean }) {
  const { services } = useApp();
  const [html, setHtml] = useState(signature.html);
  const [auto, setAuto] = useState(signature.auto);
  /** Bumped to put the editor back to what's saved. */
  const [version, setVersion] = useState(0);
  const [pending, start] = useTransition();
  const changed = html !== signature.html || auto !== signature.auto;
  const save = () =>
    start(async () => {
      const r = await updateEmailSignature({ html, auto });
      if (!r.ok) return void toast.error(r.error);
      toast.success(html ? "Signature saved" : signature.html ? "Signature removed" : "Saved");
    });
  return (
    <Section
      title="Email signature"
      description={`Goes under email you send from your Outlook through the CRM, to a person, an organization or a client's contacts.${connected ? "" : " Connect your Microsoft account above to send with it."}`}
    >
      <div className="flex flex-col gap-3 p-5">
        <SignatureEditor key={version} value={signature.html} onChange={setHtml} canUpload={services.blob} />
        <p className="-mt-1 text-fine">Images are public so inboxes can show them. Drag a corner of an image to resize it.{!html && signature.workspace ? " Until you make your own, the workspace's signature from the brand kit is used." : ""}</p>
        <Checkbox checked={auto} onChange={(e) => setAuto(e.target.checked)} label={<span className="text-[13.5px]">Add my signature to every email I send from Outlook</span>} />
        <p className="-mt-2 pl-6 text-fine">{auto ? "It's already there when you start an email. Take it off any one before sending." : "Add it to an email from the composer when you want it."}</p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" loading={pending} disabled={!changed} onClick={save}>
            Save signature
          </Button>
          {changed ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setHtml(signature.html);
                setAuto(signature.auto);
                setVersion((v) => v + 1);
              }}
            >
              Discard changes
            </Button>
          ) : null}
        </div>
      </div>
    </Section>
  );
}
