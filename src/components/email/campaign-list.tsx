"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { EllipsisHorizontalIcon, PlusIcon } from "@heroicons/react/20/solid";
import { EnvelopeIcon } from "@heroicons/react/24/outline";
import { createCampaign, deleteCampaign, duplicateCampaign } from "@/actions/campaigns";
import { useApp } from "@/components/app-context";
import { PageHeader } from "@/components/shell/app-shell";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { formatDateTime } from "@/lib/format";
import { EmailTabs } from "./email-tabs";

export type CampaignRow = { id: string; name: string; subject: string; status: "draft" | "scheduled" | "sending" | "sent"; scheduledAt: Date | null; sentAt: Date | null; recipientCount: number; sendError: string | null; updatedAt: Date };

const tone = { draft: "neutral", scheduled: "info", sending: "warning", sent: "success" } as const;
const label = { draft: "Draft", scheduled: "Scheduled", sending: "Sending", sent: "Sent" } as const;

export function CampaignList({ rows }: { rows: CampaignRow[] }) {
  const router = useRouter();
  const { workspace, services } = useApp();
  const [pending, start] = useTransition();
  const tz = workspace.timezone;
  const create = () =>
    start(async () => {
      const r = await createCampaign();
      if (!r.ok) return void toast.error(r.error);
      router.push(`/email/campaigns/${r.data.id}`);
    });
  return (
    <>
      <PageHeader
        title="Email"
        sub={!services.email ? <p className="mt-0.5 text-[12px] text-muted">Email isn&apos;t connected yet, so sends print to the server log. Add RESEND_API_KEY to send for real.</p> : null}
      >
        <Button variant="primary" onClick={create} loading={pending}>
          <PlusIcon />
          Campaign
        </Button>
      </PageHeader>
      <EmailTabs />
      <div className="mx-auto max-w-5xl px-4 py-5 lg:px-6">
        {rows.length ? (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {rows.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-3 hover:bg-sunken/50">
                <Link href={`/email/campaigns/${c.id}`} className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-medium text-primary">{c.name}</p>
                  <p className="truncate text-[12.5px] text-muted">{c.subject || "No subject yet"}</p>
                  {c.sendError ? <p className="mt-0.5 text-[12px] text-error">Didn&apos;t send: {c.sendError}</p> : null}
                </Link>
                <span className="hidden text-right text-[12.5px] text-muted sm:block" suppressHydrationWarning>
                  {c.status === "sent" && c.sentAt
                    ? `${c.recipientCount.toLocaleString()} recipients · ${formatDateTime(c.sentAt, tz)}`
                    : c.status === "scheduled" && c.scheduledAt
                      ? formatDateTime(c.scheduledAt, tz)
                      : c.status === "sending"
                        ? `${c.recipientCount.toLocaleString()} sent so far`
                        : `Edited ${formatDateTime(c.updatedAt, tz)}`}
                </span>
                <StatusBadge tone={tone[c.status]}>{label[c.status]}</StatusBadge>
                <Menu>
                  <MenuTrigger asChild>
                    <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${c.name}`}>
                      <EllipsisHorizontalIcon />
                    </Button>
                  </MenuTrigger>
                  <MenuContent className="w-44">
                    <MenuItem
                      onSelect={async () => {
                        const r = await duplicateCampaign(c.id);
                        if (!r.ok) return void toast.error(r.error);
                        router.push(`/email/campaigns/${r.data.id}`);
                      }}
                    >
                      Duplicate
                    </MenuItem>
                    {c.status === "draft" || c.status === "scheduled" ? (
                      <MenuItem
                        destructive
                        onSelect={async () => {
                          if (!confirm(`Delete “${c.name}”?`)) return;
                          const r = await deleteCampaign(c.id);
                          if (!r.ok) toast.error(r.error);
                        }}
                      >
                        Delete
                      </MenuItem>
                    ) : null}
                  </MenuContent>
                </Menu>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={EnvelopeIcon}
            title="No campaigns yet"
            description="Send a branded email to a group of people: everyone tagged “newsletter”, say, or everyone with a deal in Proposal."
            action={
              <Button variant="primary" onClick={create} loading={pending}>
                Create your first campaign
              </Button>
            }
          />
        )}
      </div>
    </>
  );
}
