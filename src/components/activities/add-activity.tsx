"use client";

import { useEffect, useState } from "react";
import { PlusIcon } from "@heroicons/react/20/solid";
import { composerTarget } from "@/actions/activities";
import { Composer, Segmented, type Links } from "@/components/activity/composer";
import type { Contact } from "@/components/activity/people-picker";
import { useApp } from "@/components/app-context";
import { RecordPicker, type PickerValue } from "@/components/records/record-picker";
import { Button, Spinner } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";

type Kind = "person" | "organization" | "client";
type Target = { recipient: Contact | null; contacts: Contact[] };

const kindLabels: Record<Kind, string> = { person: "Person", organization: "Organization", client: "Client" };

/**
 * "Add activity" on the Activities page: pick the person, organization or
 * client it's for, then the same composer as on that record's page, so the
 * type tabs, defaults and sending all work the way they do there.
 */
export function AddActivity() {
  const { canEdit } = useApp();
  const [open, setOpen] = useState(false);
  if (!canEdit) return null;
  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
        <PlusIcon />
        Add activity
      </Button>
      {open ? <AddActivityDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function AddActivityDialog({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<Kind>("client");
  const [picked, setPicked] = useState<PickerValue>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const record = picked && "record" in picked ? picked.record : null;

  // Who it can be with comes from the record, the same list its own page offers.
  useEffect(() => {
    if (!record) return;
    let live = true;
    composerTarget(kind, record.id).then((r) => {
      if (!live) return;
      if (!r.ok) return void toast.error(r.error);
      setTarget(r.data);
    });
    return () => {
      live = false;
    };
  }, [kind, record]);

  const links: Links = record ? (kind === "person" ? { personId: record.id } : kind === "organization" ? { organizationId: record.id } : { clientId: record.id }) : {};

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Add activity" description="Pick who it's for, then the kind of activity." size="lg">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            value={kind}
            onChange={(k) => {
              setKind(k);
              setPicked(null);
              setTarget(null);
            }}
            options={(["client", "person", "organization"] as const).map((k) => ({ value: k, label: kindLabels[k] }))}
          />
        </div>
        <RecordPicker
          key={kind}
          kind={kind}
          value={picked}
          onChange={(v) => {
            setPicked(v);
            setTarget(null);
          }}
          allowCreate={false}
          autoFocus
          id="add-activity-record"
        />
        {!record ? (
          <p className="text-[12.5px] text-muted">Search for the {kindLabels[kind].toLowerCase()} this activity belongs to.</p>
        ) : !target ? (
          <p className="flex items-center gap-2 text-[13px] text-muted" role="status">
            <Spinner className="size-3.5" />
            Loading…
          </p>
        ) : (
          <Composer key={`${kind}:${record.id}`} links={links} recipient={target.recipient} contacts={target.contacts} onDone={onClose} />
        )}
      </div>
    </Dialog>
  );
}
