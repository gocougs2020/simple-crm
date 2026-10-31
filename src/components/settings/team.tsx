"use client";

import { useState, useTransition } from "react";
import { EllipsisHorizontalIcon, PlusIcon } from "@heroicons/react/20/solid";
import { inviteTeammate, resendInvite, setDeactivated, setRole } from "@/actions/settings";
import { useApp } from "@/components/app-context";
import { Avatar } from "@/components/ui/avatar";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { formatAgo } from "@/lib/format";
import { Section } from "./nav";

export type TeamRow = { id: string; name: string; email: string; role: string; title: string | null; invited: boolean; deactivated: boolean; lastSeenAt: Date | null };

const roleLabels: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

export function TeamSettings({ rows }: { rows: TeamRow[] }) {
  const { viewer, isAdmin, workspace } = useApp();
  const [inviting, setInviting] = useState(false);
  const [devLink, setDevLink] = useState<string | null>(null);
  const showLink = (url: string | null) => url && setDevLink(url);
  return (
    <>
      <Section
        title="Team"
        description="Everyone here can see and edit every record. Admins also manage settings and the team. Owners can't be removed by admins."
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
                  {u.name}
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
              {u.deactivated ? <StatusBadge>Deactivated</StatusBadge> : u.invited ? <StatusBadge tone="warning">Invite sent</StatusBadge> : null}
              <span className="w-16 text-right text-[13px] text-secondary">{roleLabels[u.role]}</span>
              {isAdmin && u.id !== viewer.id ? (
                <Menu>
                  <MenuTrigger asChild>
                    <Button size="icon-sm" variant="ghost" aria-label={`Manage ${u.name}`}>
                      <EllipsisHorizontalIcon />
                    </Button>
                  </MenuTrigger>
                  <MenuContent className="w-52">
                    {(["admin", "member", ...(viewer.role === "owner" ? ["owner"] : [])] as const)
                      .filter((r) => r !== u.role)
                      .map((r) => (
                        <MenuItem key={r} onSelect={async () => toastResult(await setRole(u.id, r as "admin"), `${u.name} is now ${roleLabels[r].toLowerCase()}`)}>
                          Make {roleLabels[r].toLowerCase()}
                        </MenuItem>
                      ))}
                    {u.invited && !u.deactivated ? (
                      <MenuItem
                        onSelect={async () => {
                          const r = await resendInvite(u.id);
                          if (!r.ok) return void toast.error(r.error);
                          toast.success(`New invite sent to ${u.email}`);
                          showLink(r.data.devUrl);
                        }}
                      >
                        Resend invite
                      </MenuItem>
                    ) : null}
                    <MenuSeparator />
                    <MenuItem destructive={!u.deactivated} onSelect={async () => toastResult(await setDeactivated(u.id, !u.deactivated), u.deactivated ? `${u.name} reactivated` : `${u.name} deactivated and signed out`)}>
                      {u.deactivated ? "Reactivate" : "Deactivate"}
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
      {inviting ? <InviteDialog onClose={() => setInviting(false)} onLink={showLink} /> : null}
      {devLink ? (
        <Dialog open onOpenChange={() => setDevLink(null)} title="Invite link" description="Email isn't set up locally, so here's the link that would have been emailed." size="md">
          <Input readOnly value={devLink} onFocus={(e) => e.target.select()} />
        </Dialog>
      ) : null}
    </>
  );
}

function toastResult(r: { ok: boolean; error?: string }, message: string) {
  if (r.ok) toast.success(message);
  else toast.error(r.error ?? "Something went wrong.");
}

function InviteDialog({ onClose, onLink }: { onClose: () => void; onLink: (url: string | null) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [pending, start] = useTransition();
  const submit = () =>
    start(async () => {
      const r = await inviteTeammate({ name, email, role });
      if (!r.ok) return void toast.error(r.error);
      toast.success(`Invite sent to ${email}`);
      onClose();
      onLink(r.data.devUrl);
    });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Invite a teammate"
      description="They'll get an email with a link to set their password. The link works for 7 days."
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
        <Field label="Role" hint={role === "admin" ? "Admins can change settings, pipelines, fields and the team." : "Members can work every record but not change settings."}>
          {(p) => (
            <Select id={p.id} value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </Select>
          )}
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
