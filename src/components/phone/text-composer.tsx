"use client";

import { useState, useTransition } from "react";
import { sendTextMessage } from "@/actions/phone";
import { useApp } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Kbd, Select, Textarea } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { formatPhone, smsSegments } from "@/lib/phone/numbers";

export type TextRecipient = { personId: string; name: string; phone: string | null; optedOut?: boolean };

/** Texts the record's person from one of the team's numbers. It's saved to the timeline, and replies land there too. */
export function TextComposer({ recipient, clientId, draft, onDraftSent }: { recipient: TextRecipient; clientId?: string | null; draft?: { body: string } | null; onDraftSent?: () => void }) {
  const { comms } = useApp();
  const [numberId, setNumberId] = useState(comms.defaultNumberId ?? comms.numbers[0]?.id ?? "");
  // A draft the agent wrote starts the text off.
  const [body, setBody] = useState(draft?.body ?? "");
  const [pending, start] = useTransition();
  const segments = smsSegments(body);

  const send = () =>
    start(async () => {
      const r = await sendTextMessage({ phoneNumberId: numberId, personId: recipient.personId, clientId: clientId ?? null, body });
      if (!r.ok) return void toast.error(r.error);
      toast.success(`Text sent to ${recipient.name}`);
      onDraftSent?.();
      setBody("");
    });

  if (recipient.optedOut) return <p className="text-[13px] text-muted">{recipient.name} replied STOP, so texts to them are blocked. They can reply START to opt back in.</p>;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        {comms.numbers.length > 1 ? (
          <>
            <label htmlFor="text-from" className="text-muted">
              From
            </label>
            <Select id="text-from" value={numberId} onChange={(e) => setNumberId(e.target.value)} className="min-w-0 flex-1 [&_select]:h-8 pointer-coarse:[&_select]:h-10 [&_select]:text-[13px]">
              {comms.numbers.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label} · {formatPhone(n.number)}
                </option>
              ))}
            </Select>
          </>
        ) : (
          <span className="text-muted">From {comms.numbers[0] ? `${comms.numbers[0].label} · ${formatPhone(comms.numbers[0].number)}` : "—"}</span>
        )}
        <span className="text-muted">
          To <span className="text-primary">{recipient.name}</span> {recipient.phone ? `· ${formatPhone(recipient.phone)}` : null}
        </span>
      </div>
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && body.trim() && send()}
        rows={3}
        maxLength={1600}
        placeholder={`Text ${recipient.name.split(" ")[0]}`}
        aria-label="Text message"
      />
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-muted tabular-nums">
          {body.length ? `${body.length} characters · ${segments} ${segments === 1 ? "message" : "messages"}` : "Long texts are split into several messages."}
        </span>
        <span className="ml-auto hidden text-[11.5px] text-faint sm:inline">
          <Kbd>⌘</Kbd> <Kbd>↵</Kbd>
        </span>
        <Button variant="primary" size="sm" loading={pending} disabled={!body.trim() || !numberId} onClick={send}>
          Send text
        </Button>
      </div>
    </div>
  );
}
