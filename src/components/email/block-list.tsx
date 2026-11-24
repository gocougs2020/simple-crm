"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { AtSymbolIcon, GlobeAltIcon, NoSymbolIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { blockMailSender, unblockMailSender } from "@/actions/accounts";
import { PageHeader } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { MAX_BLOCKED } from "@/lib/microsoft/sync-rules";
import { EmailTabs } from "./email-tabs";

/**
 * Email → Block list: addresses and domains whose mail is never synced from
 * the viewer's own Outlook. Deleting an email in My Outlook can add its
 * sender here; this is where they're added by hand and taken off again.
 */
export function BlockList({ account }: { account: { email: string; blocked: string[] } | null }) {
  const [entry, setEntry] = useState("");
  const [pending, start] = useTransition();
  const [removing, setRemoving] = useState<string | null>(null);

  const add = () =>
    start(async () => {
      const value = entry.trim();
      if (!value) return;
      const r = await blockMailSender({ entry: value });
      if (!r.ok) return void toast.error(r.error);
      setEntry("");
      toast.success(`Mail with ${r.data.entry} won't sync anymore`);
    });
  const remove = (e: string) =>
    start(async () => {
      setRemoving(e);
      const r = await unblockMailSender({ entry: e });
      setRemoving(null);
      if (!r.ok) return void toast.error(r.error);
      toast.success(`${e} is off the block list. Its mail syncs again from the next sync.`);
    });

  return (
    <>
      <PageHeader title="Email" />
      <EmailTabs />
      <div className="mx-auto max-w-2xl px-4 py-5 lg:px-6">
        {!account ? (
          <EmptyState
            icon={NoSymbolIcon}
            title="Your Outlook isn't connected"
            description="The block list keeps mail from your own mailbox out of the CRM. Connect your Microsoft account to use it."
            action={
              <Button variant="primary" asChild>
                <Link href="/settings/accounts">Open Email and calendar settings</Link>
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-[15px] font-semibold text-primary">Block list</h2>
              <p className="mt-0.5 text-[13px] text-secondary">
                Mail from or to anyone here is never synced from <span className="font-medium text-primary">{account.email}</span>, and nothing about it is kept. A domain like news.acme.com covers everyone there. Mail already synced stays until you delete it from My Outlook.
              </p>
            </div>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                add();
              }}
            >
              <Input value={entry} onChange={(e) => setEntry(e.target.value)} placeholder="promo@shop.com or shop.com" aria-label="Address or domain to block" className="max-w-sm" />
              <Button type="submit" variant="outline" loading={pending && !removing} disabled={!entry.trim()}>
                Block
              </Button>
            </form>
            {account.blocked.length ? (
              <ul className="divide-y divide-line rounded-xl border border-line bg-surface">
                {account.blocked.map((b) => {
                  const Icon = b.includes("@") ? AtSymbolIcon : GlobeAltIcon;
                  return (
                    <li key={b} className="flex items-center gap-3 px-4 py-2.5">
                      <Icon className="size-4 shrink-0 text-faint" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-[13px] text-primary">{b}</span>
                        <span className="block text-[12px] text-muted">{b.includes("@") ? "This address" : "Everyone at this domain"}</span>
                      </span>
                      <Button size="sm" variant="ghost" loading={removing === b} disabled={pending} onClick={() => remove(b)} aria-label={`Unblock ${b}`}>
                        <XMarkIcon />
                        Unblock
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState variant="minimal" icon={NoSymbolIcon} title="Nobody is blocked" description="Block a sender when you delete their email in My Outlook, or add an address or domain above." />
            )}
            <p className="text-fine">
              {account.blocked.length} of {MAX_BLOCKED} used. The same list is in{" "}
              <Link href="/settings/accounts" className="font-medium text-accent hover:underline">
                Settings → Email and calendar
              </Link>
              .
            </p>
          </div>
        )}
      </div>
    </>
  );
}
