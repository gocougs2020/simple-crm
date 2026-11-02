"use client";

import Link from "next/link";
import { useApp } from "@/components/app-context";
import { SideCard } from "@/components/records/inline-field";
import type { threadsFor } from "@/lib/email/inbox";
import { formatAgo } from "@/lib/format";

export type ThreadSummary = Awaited<ReturnType<typeof threadsFor>>[number];

/** Recent inbox conversations with a record's people, for its side panel. Each opens in the inbox. */
export function EmailThreadsCard({ threads }: { threads: ThreadSummary[] }) {
  const { workspace } = useApp();
  return (
    <SideCard
      title={
        <>
          Conversations <span className="font-medium text-muted tabular-nums">{threads.length || ""}</span>
        </>
      }
      action={
        <Link href="/email" className="text-[12.5px] text-muted hover:text-primary">
          Inbox
        </Link>
      }
    >
      {threads.length ? (
        <ul className="-mx-2">
          {threads.map((t) => (
            <li key={t.id}>
              <Link href={`/email?t=${t.id}`} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-sunken">
                <span className="mt-1.5 size-2 shrink-0 rounded-full" aria-hidden>
                  {!t.read ? <span className="block size-2 rounded-full bg-accent" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className={`min-w-0 flex-1 truncate text-[13px] ${t.read ? "font-medium text-secondary" : "font-semibold text-primary"}`}>{t.subject || "(no subject)"}</span>
                    {t.lastMessageAt ? (
                      <time className="shrink-0 text-[11.5px] text-faint" suppressHydrationWarning>
                        {formatAgo(t.lastMessageAt, workspace.timezone)}
                      </time>
                    ) : null}
                  </span>
                  <span className="block truncate text-[11.5px] text-muted">
                    {t.messageCount > 1 ? `${t.messageCount} messages · ` : ""}
                    {t.snippet ?? t.inboxAddress}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-1 text-[12.5px] text-muted">No conversations yet. Mail to and from these people shows up here.</p>
      )}
    </SideCard>
  );
}
