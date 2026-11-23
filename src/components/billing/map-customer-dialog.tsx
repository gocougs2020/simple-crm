"use client";

import { useState, useTransition } from "react";
import { linkStripeCustomer } from "@/actions/clients";
import { RecordPicker, type PickerValue } from "@/components/records/record-picker";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";

export type MapTarget = { account: string; customerId: string; name: string | null; email: string | null };

/**
 * Puts a Stripe customer on a client by hand, for one whose billing email
 * isn't on any of the client's people. The same link a client's billing card
 * makes, so it's recorded in the client's history and its billing updates
 * straight away.
 */
export function MapCustomerDialog({ target, onClose }: { target: MapTarget; onClose: () => void }) {
  const [value, setValue] = useState<PickerValue>(null);
  const [pending, start] = useTransition();
  const client = value && "record" in value ? value.record : null;
  const who = target.name || target.email || target.customerId;
  const save = () =>
    start(async () => {
      if (!client) return;
      const r = await linkStripeCustomer(client.id, target.account, target.customerId);
      if (!r.ok) return void toast.error(r.error);
      toast.success(`${who} is mapped to ${client.label}. Its invoices and payments show on the client now.`);
      onClose();
    });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title="Map to a client"
      description={
        <>
          <span className="font-medium text-secondary">{who}</span>
          {target.email && target.email !== who ? ` (${target.email})` : ""} isn&apos;t on anyone at a client. Pick the client it bills for.
        </>
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!client} loading={pending}>
            Map customer
          </Button>
        </>
      }
    >
      <RecordPicker kind="client" value={value} onChange={setValue} allowCreate={false} placeholder="Search clients" autoFocus />
      <p className="mt-2 text-[12px] text-muted">To match it by email instead, add {target.email ?? "its billing email"} to one of the client&apos;s people. Mapping by hand keeps working if the email changes.</p>
    </Dialog>
  );
}
