"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { CheckIcon, ClipboardDocumentIcon, EllipsisHorizontalIcon, LinkIcon, PlusIcon } from "@heroicons/react/20/solid";
import { changeEmail, inviteLink, inviteTeammate, resendInvite, setDeactivated, setRole, type InviteSent } from "@/actions/settings";
import { useApp } from "@/components/app-context";
import { TeammateStatus } from "@/components/team/invite-status";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { roleHints, roleLabels, type UserRole } from "@/lib/constants";
import type { InviteState } from "@/lib/invite-state";
import { formatAgo, formatDay } from "@/lib/format";
import { Section } from "./nav";

export type TeamRow = { id: string; name: string; email: string; role: string; title: string | null; invite: InviteState; deactivated: boolean; lastSeenAt: Date | null };

export function TeamSettings({ rows }: { rows: TeamRow[] }) {
  const { viewer, isAdmin, workspace } = useApp();
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<ShownLink | null>(null);
  const [editingEmail, setEditingEmail] = useState<TeamRow | null>(null);
  /** After an invite goes out: a toast if it was emailed, otherwise the link to send by hand. */
  const afterInvite = (u: { name: string; email: string }, sent: InviteSent, emailedMessage: string) => {
    if (sent.emailed) toast.success(emailedMessage);
    else setLink({ name: u.name, url: sent.url, expiresAt: sent.expiresAt, notEmailed: true });
  };
  const copyLink = async (u: TeamRow) => {
    const r = await inviteLink(u.id);
    if (!r.ok) return void toast.error(r.error);
    setLink({ name: u.name, url: r.data.url, expiresAt: r.data.expiresAt, notEmailed: false });
  };
  return (
    <>
      <Section
        title="Team"
        description="Members see and edit every record; viewers only see them. Admins also manage settings and the team. Owners can't be removed by admins. Agents connected through MCP get their teammate's role."
        action={
          isAdmin ? (
            <Button variant="primary" onClick={() => setInviting(true)}>
              <PlusIcon />
              Invite
            </Button>
          ) : null
        }
      >
        <ul className="divide-y divide-line">
          {rows.map((u) => (
            <li key={u.id} className="flex items-center gap-3 px-4 py-3">
              <Avatar name={u.name} size="md" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium text-primary">
                  <Link href={`/team/${u.id}`} className="hover:underline">
                    {u.name}
                  </Link>
                  {u.id === viewer.id ? <span className="font-normal text-muted"> (you)</span> : null}
                </p>
                <p className="truncate text-[12.5px] text-muted">
                  {u.email}
                  {u.title ? ` · ${u.title}` : ""}
                </p>
              </div>
              <span className="hidden text-[12px] text-muted sm:block" suppressHydrationWarning>
                {u.lastSeenAt ? `Active ${formatAgo(u.lastSeenAt, workspace.timezone)}` : ""}
              </span>
              <TeammateStatus deactivated={u.deactivated} invite={u.invite} />
              {isAdmin && !u.deactivated && u.invite?.state === "sent" ? (
                <Button size="sm" variant="ghost" onClick={() => copyLink(u)} aria-label={`Invite link for ${u.name}`}>
                  <LinkIcon />
                  <span className="max-sm:hidden">Invite link</span>
                </Button>
              ) : null}
              <span className="w-16 text-right text-[13px] text-secondary">{roleLabels[u.role as UserRole]}</span>
              {isAdmin && u.id !== viewer.id ? (
                <Menu>
                  <MenuTrigger asChild>
                    <Button size="icon-sm" variant="ghost" aria-label={`Manage ${u.name}`}>
                      <EllipsisHorizontalIcon />
                    </Button>
                  </MenuTrigger>
                  <MenuContent className="w-52">
                    {(["admin", "member", "viewer", ...(viewer.role === "owner" && !u.invite ? ["owner"] : [])] as UserRole[])
                      .filter((r) => r !== u.role)
                      .map((r) => (
                        <MenuItem key={r} onSelect={async () => toastResult(await setRole(u.id, r), `${u.name} is now ${r === "admin" ? "an" : "a"} ${roleLabels[r].toLowerCase()}`)}>
                          Make {roleLabels[r].toLowerCase()}
                        </MenuItem>
                      ))}
                    {u.invite && !u.deactivated ? (
                      <>
                        <MenuItem
                          onSelect={async () => {
                            const r = await resendInvite(u.id);
                            if (!r.ok) return void toast.error(r.error);
                            afterInvite(u, r.data, `New invite sent to ${u.email}`);
                          }}
                        >
                          {u.invite.state === "none" ? "Send invite" : "Resend invite"}
                        </MenuItem>
                        {u.invite.state === "sent" ? <MenuItem onSelect={() => copyLink(u)}>Copy invite link</MenuItem> : null}
                      </>
                    ) : null}
                    {viewer.role === "owner" ? <MenuItem onSelect={() => setEditingEmail(u)}>Change email</MenuItem> : null}
                    <MenuSeparator />
                    <MenuItem
                      destructive={!u.deactivated}
                      onSelect={async () => {
                        const r = await setDeactivated(u.id, !u.deactivated);
                        if (!r.ok) return void toast.error(r.error);
                        if (!u.deactivated) return void toast.success(`${u.name} deactivated and signed out`);
                        if (r.data.invite) afterInvite(u, r.data.invite, `${u.name} reactivated and invited at ${u.email}`);
                        else toast.success(`${u.name} reactivated`);
                      }}
                    >
                      {!u.deactivated ? "Deactivate" : u.invite ? "Reactivate and invite" : "Reactivate"}
                    </MenuItem>
                  </MenuContent>
                </Menu>
              ) : (
                <span className="w-8" />
              )}
            </li>
          ))}
        </ul>
      </Section>
      {inviting ? <InviteDialog onClose={() => setInviting(false)} onSent={afterInvite} /> : null}
      {link ? <InviteLinkDialog link={link} onClose={() => setLink(null)} /> : null}
      {editingEmail ? <ChangeEmailDialog teammate={editingEmail} onClose={() => setEditingEmail(null)} onInvite={afterInvite} /> : null}
    </>
  );
}

/** Owners only. The teammate keeps their account, password and sessions; only the address they sign in with changes. */
function ChangeEmailDialog({ teammate: u, onClose, onInvite }: { teammate: TeamRow; onClose: () => void; onInvite: (u: { name: string; email: string }, sent: InviteSent, emailedMessage: string) => void }) {
  const [email, setEmail] = useState(u.email);
  const [pending, start] = useTransition();
  const first = u.name.split(" ")[0];
  const submit = () =>
    start(async () => {
      const r = await changeEmail(u.id, email);
      if (!r.ok) return void toast.error(r.error);
      onClose();
      if (r.data.email === u.email) return;
      if (r.data.invite) onInvite({ name: u.name, email: r.data.email }, r.data.invite, `${u.name} now signs in with ${r.data.email}. We sent their invite there.`);
      else toast.success(`${u.name} now signs in with ${r.data.email}`);
    });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Change ${first}'s email`}
      description={`${first} signs in with the new address from now on. Their password, history and records stay the same and they stay signed in.${u.invite || u.deactivated ? "" : " We'll let them know at their old address."}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Work email">{(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />}</Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

type ShownLink = { name: string; url: string; expiresAt: Date; notEmailed: boolean };

/** An invite link to copy and send by hand: on request, or because the email didn't go out. */
function InviteLinkDialog({ link, onClose }: { link: ShownLink; onClose: () => void }) {
  const { workspace } = useApp();
  const [copied, setCopied] = useState(false);
  const first = link.name.split(" ")[0];
  const day = formatDay(link.expiresAt, workspace.timezone);
  const expires = day === "Today" || day === "Tomorrow" ? day.toLowerCase() : `on ${day}`;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Invite link for ${link.name}`}
      description={
        link.notEmailed
          ? `The invite email didn't go out, so send ${first} this link yourself. It works once and expires ${expires}.`
          : `Send ${first} this link yourself. It's the link from their latest invite, works once and expires ${expires}.`
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link.url);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                toast.error("Couldn't copy. Select the link and copy it instead.");
              }
            }}
          >
            {copied ? <CheckIcon /> : <ClipboardDocumentIcon />}
            {copied ? "Copied" : "Copy link"}
          </Button>
        </>
      }
    >
      <Input readOnly aria-label="Invite link" value={link.url} onFocus={(e) => e.target.select()} />
    </Dialog>
  );
}

function toastResult(r: { ok: boolean; error?: string }, message: string) {
  if (r.ok) toast.success(message);
  else toast.error(r.error ?? "Something went wrong.");
}

function InviteDialog({ onClose, onSent }: { onClose: () => void; onSent: (u: { name: string; email: string }, sent: InviteSent, emailedMessage: string) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin" | "viewer">("member");
  const [pending, start] = useTransition();
  const submit = () =>
    start(async () => {
      const r = await inviteTeammate({ name, email, role });
      if (!r.ok) return void toast.error(r.error);
      onClose();
      onSent({ name, email }, r.data, `Invite sent to ${email}`);
    });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Invite a teammate"
      description="They'll get an email with a link to set their password. The link works for 7 days, and you can copy it from the team list to send another way."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={submit}>
            Send invite
          </Button>
        </>
      }
    >
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} required />}</Field>
        <Field label="Work email">{(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />}</Field>
        <Field label="Role" hint={roleHints[role]}>
          {(p) => (
            <Select id={p.id} value={role} onChange={(e) => setRole(e.target.value as "member" | "admin" | "viewer")}>
              <option value="member">Member</option>
              <option value="viewer">Viewer</option>
              <option value="admin">Admin</option>
            </Select>
          )}
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
