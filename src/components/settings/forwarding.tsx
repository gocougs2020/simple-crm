"use client";

import { useState } from "react";
import { CheckIcon, ClipboardDocumentIcon } from "@heroicons/react/20/solid";
import { appConfig } from "@/app.config";
import { useApp } from "@/components/app-context";
import { StatusBadge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { emailForwardStatusLabels, type EmailForwardStatus } from "@/lib/constants";
import { formatDateTime } from "@/lib/format";
import { Section } from "./nav";

export type ForwardItem = { id: string; subject: string | null; fromAddress: string | null; status: EmailForwardStatus; reason: string | null; round: number; runId: string | null; receivedAt: string };

const tones: Record<EmailForwardStatus, Tone> = { received: "neutral", working: "info", answered: "success", refused: "warning", failed: "error" };

/**
 * Settings → Agent → Email forwarding. The team's one address, and what this
 * teammate sent to it lately with why anything was refused, so a domain
 * without DKIM or an email sent from another address is easy to spot.
 */
export function ForwardingSettings({ available, unavailableReason, address, recent }: { available: boolean; unavailableReason: string | null; address: string | null; recent: ForwardItem[] }) {
  const { canEdit, viewer, workspace } = useApp();
  const name = appConfig.agent.name;
  const [copied, setCopied] = useState(false);

  return (
    <Section
      title="Email forwarding"
      description={`Forward an email to ${name}, or Cc ${name} on an internal thread, and it records what matters on the right clients, people and organizations, then replies to whoever sent it with what it did. When it isn't sure where something goes, it asks, and you answer by replying.`}
    >
      {!available || !address ? (
        <p className="px-4 py-6 text-center text-[13px] text-muted">{unavailableReason}</p>
      ) : (
        <div className="px-4 py-3">
          <p className="text-[12.5px] font-medium text-muted">{name}&apos;s address, for the whole team</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <code className="min-w-0 break-all rounded bg-sunken px-2 py-1 font-mono text-[13px] text-primary">{address}</code>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Copy address"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(address);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch {
                  // Clipboard blocked: the address is still selectable.
                }
              }}
            >
              {copied ? <CheckIcon /> : <ClipboardDocumentIcon />}
              <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
            </Button>
          </div>
          <ul className="mt-2 max-w-xl list-disc space-y-1 pl-4 text-[12.5px] text-muted">
            <li>
              It works for whoever sends it: send from {viewer.email}, and it acts as you. On a thread, each teammate&apos;s message counts as theirs; clients&apos; replies are ignored.
            </li>
            <li>Add a line at the top to say what you want (&quot;log this on Acme and add a task for me&quot;).</li>
            <li>Old threads are fine: press Forward on them. What isn&apos;t read is an old email sent again unchanged, or the same email twice.</li>
            {canEdit ? null : <li>Your role is read-only, so {name} can&apos;t change records for you. Ask an admin for edit access.</li>}
          </ul>
        </div>
      )}

      {available && recent.length ? (
        <div className="border-t border-line">
          <p className="px-4 pt-3 text-[12.5px] font-medium text-muted">Recent emails</p>
          <ul className="divide-y divide-line">
            {recent.map((f) => (
              <li key={f.id} className="flex items-start gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-primary">
                    {f.subject || "(no subject)"}
                    {f.round > 1 ? <span className="text-muted"> · reply {f.round - 1}</span> : null}
                  </span>
                  <span className="block truncate text-[12.5px] text-muted">
                    {formatDateTime(f.receivedAt, workspace.timezone)}
                    {f.fromAddress ? ` · from ${f.fromAddress}` : ""}
                  </span>
                  {f.reason && f.status !== "answered" ? <span className="mt-0.5 block text-[12.5px] text-secondary">{f.reason}</span> : null}
                </span>
                <StatusBadge tone={tones[f.status]}>{emailForwardStatusLabels[f.status]}</StatusBadge>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Section>
  );
}
