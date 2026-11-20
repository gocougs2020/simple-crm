"use client";

import { useState, useTransition } from "react";
import { CheckIcon, ClipboardDocumentIcon } from "@heroicons/react/20/solid";
import { changeForwarding } from "@/actions/forwarding";
import { appConfig } from "@/app.config";
import { useApp } from "@/components/app-context";
import { StatusBadge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { emailForwardStatusLabels, type EmailForwardStatus } from "@/lib/constants";
import { formatDateTime } from "@/lib/format";
import { Section } from "./nav";

export type ForwardItem = { id: string; subject: string | null; fromAddress: string | null; status: EmailForwardStatus; reason: string | null; round: number; runId: string | null; receivedAt: string };

const tones: Record<EmailForwardStatus, Tone> = { received: "neutral", working: "info", answered: "success", refused: "warning", failed: "error" };

/**
 * Settings → Agent → Email forwarding. The teammate's private address, and
 * what arrived at it lately with why anything was refused, so a domain
 * without DKIM or a forward from the wrong address is easy to spot.
 */
export function ForwardingSettings({ available, unavailableReason, address, recent }: { available: boolean; unavailableReason: string | null; address: string | null; recent: ForwardItem[] }) {
  const { canEdit, viewer, workspace } = useApp();
  const name = appConfig.agent.name;
  const [pending, start] = useTransition();
  const [copied, setCopied] = useState(false);

  const act = (action: "on" | "new" | "off", done: string) =>
    start(async () => {
      const r = await changeForwarding(action);
      if (!r.ok) return void toast.error(r.error);
      toast.success(done);
    });

  return (
    <Section
      title="Email forwarding"
      description={`Forward an email to ${name}, or Cc it on your own email in an internal thread, and it records what matters on the right clients, people and organizations, then replies to tell you what it did. When it isn't sure where something goes, it asks, and you answer by replying. Only email from ${viewer.email} with your domain's signature is accepted.`}
      action={
        available && canEdit && !address ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => act("on", "Forwarding turned on")}>
            Turn on
          </Button>
        ) : null
      }
    >
      {!available ? (
        <p className="px-4 py-6 text-center text-[13px] text-muted">{unavailableReason}</p>
      ) : address ? (
        <div className="px-4 py-3">
          <p className="text-[12.5px] font-medium text-muted">Your address</p>
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
          <p className="mt-2 max-w-xl text-[12.5px] text-muted">
            Keep it to yourself: anyone on a thread you Cc it on can see it. Cc it only on internal threads, or forward instead. Only your own emails are read; a teammate&apos;s reply-all is ignored, so forward the thread once the conversation has said what matters. Add a line at the top to say what you want (&quot;log this on Acme and add a task for me&quot;).
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {canEdit ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  if (confirm("Replace your address? The current one stops working right away, including for replies to emails already sent.")) act("new", "New address ready");
                }}
              >
                New address
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                if (confirm("Turn forwarding off? Email to your address stops being read right away.")) act("off", "Forwarding turned off");
              }}
            >
              Turn off
            </Button>
          </div>
        </div>
      ) : (
        <p className="px-4 py-6 text-center text-[13px] text-muted">{canEdit ? "Off. Turn it on to get your private address." : "Forwarding changes records, so it needs edit access. Ask an admin."}</p>
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
