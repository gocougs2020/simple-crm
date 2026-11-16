"use client";

import { useEffect, useState, useTransition } from "react";
import { PlusIcon } from "@heroicons/react/20/solid";
import { addPhoneNumber, reconnectPhoneNumbers, removePhoneNumber, setUpBrowserCalling, twilioAccountNumbers, updatePhoneNumber } from "@/actions/phone";
import { useApp } from "@/components/app-context";
import { OwnerSelect } from "@/components/records/owner-select";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { formatPhone } from "@/lib/phone/numbers";
import { Section } from "./nav";

type NumberRow = { id: string; label: string; number: string; forwardTo: string | null; forwardUserId: string | null; access: "everyone" | "selected"; userIds: string[] };
type AccountNumber = Awaited<ReturnType<typeof twilioAccountNumbers>>[number];

/**
 * Settings → Phone numbers (admins): which Twilio numbers the team calls and
 * texts from, who may use each, and where incoming calls ring.
 */
export function PhoneSettings({
  configured,
  calling,
  numbers,
}: {
  configured: boolean;
  calling: { ready: boolean; fromEnv: boolean; origin: string | null; currentOrigin: string };
  numbers: NumberRow[];
}) {
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState<NumberRow | "new" | null>(null);
  const { member } = useApp();

  if (!configured) {
    return (
      <Section title="Phone numbers" description="Call from the browser, forward incoming calls to a cell phone, and text people from their records.">
        <p className="p-5 text-[13.5px] text-muted">Calling and texting aren&apos;t set up on this deployment. Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN from your Twilio console, then redeploy (see docs/PHONE.md).</p>
      </Section>
    );
  }

  const moved = calling.origin && calling.origin !== calling.currentOrigin;
  return (
    <>
      <Section
        title="Browser calling"
        description="Calls from records go through the browser: the CRM makes a calling app and a key in your Twilio account and points them here."
        action={
          <Button
            size="sm"
            variant={calling.ready && !moved ? "outline" : "primary"}
            loading={pending}
            onClick={() =>
              start(async () => {
                const r = await setUpBrowserCalling();
                if (r.ok) toast.success("Browser calling is ready");
                else toast.error(r.error);
              })
            }
          >
            {calling.ready ? "Repair" : "Set up calling"}
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-3 p-5 text-[13.5px]">
          {calling.ready ? <StatusBadge tone="success">Ready</StatusBadge> : <StatusBadge tone="warning">Not set up</StatusBadge>}
          <span className="min-w-0 flex-1 text-muted">
            {calling.ready
              ? moved
                ? `Set up for ${calling.origin}. Repair to point it at ${calling.currentOrigin}.`
                : "Teammates with a number can call from any person, organization or client."
              : "Texting works without it; calling needs it."}
          </span>
        </div>
      </Section>

      <Section
        title="Numbers"
        description="Each number's incoming calls ring a cell phone, and are logged on whoever called with a task to write them up. Texts to it land on the sender's record."
        action={
          <div className="flex gap-2">
            {numbers.length ? (
              <Button
                size="sm"
                variant="ghost"
                loading={pending}
                onClick={() =>
                  start(async () => {
                    const r = await reconnectPhoneNumbers();
                    if (r.ok) toast.success(`Pointed ${r.data.count} ${r.data.count === 1 ? "number" : "numbers"} at this deployment`);
                    else toast.error(r.error);
                  })
                }
              >
                Reconnect all
              </Button>
            ) : null}
            <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
              <PlusIcon />
              Number
            </Button>
          </div>
        }
      >
        {numbers.length ? (
          <ul className="divide-y divide-line">
            {numbers.map((n) => {
              const forwardUser = member(n.forwardUserId);
              return (
                <li key={n.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-medium text-primary">
                      {n.label} <span className="font-normal text-muted tabular-nums">{formatPhone(n.number)}</span>
                    </p>
                    <p className="text-[12.5px] text-muted">
                      {n.forwardTo ? `Calls ring ${formatPhone(n.forwardTo)}${forwardUser ? ` (${forwardUser.name})` : ""}` : "Calls aren't forwarded"} ·{" "}
                      {n.access === "everyone" ? "Everyone can use it" : `${n.userIds.length} ${n.userIds.length === 1 ? "teammate" : "teammates"} can use it`}
                    </p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(n)}>
                    Edit
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="p-5 text-[13.5px] text-muted">No numbers yet. Add one from your Twilio account.</p>
        )}
      </Section>
      {editing ? <NumberDialog row={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function NumberDialog({ row, onClose }: { row: NumberRow | null; onClose: () => void }) {
  const { team } = useApp();
  const [available, setAvailable] = useState<AccountNumber[] | null>(null);
  const [sid, setSid] = useState("");
  const [label, setLabel] = useState(row?.label ?? "");
  const [forwardTo, setForwardTo] = useState(row?.forwardTo ?? "");
  const [forwardUserId, setForwardUserId] = useState<string | null>(row?.forwardUserId ?? null);
  const [access, setAccess] = useState<"everyone" | "selected">(row?.access ?? "everyone");
  const [userIds, setUserIds] = useState<string[]>(row?.userIds ?? []);
  const [pending, start] = useTransition();
  const [loading, startLoading] = useTransition();

  useEffect(() => {
    if (row) return;
    let live = true;
    startLoading(async () => {
      try {
        const list = await twilioAccountNumbers();
        if (!live) return;
        setAvailable(list);
        if (list[0]) setSid(list[0].sid);
      } catch {
        if (!live) return;
        setAvailable([]);
        toast.error("Couldn't load the numbers from Twilio. Check the account credentials.");
      }
    });
    return () => {
      live = false;
    };
  }, [row]);

  const save = () =>
    start(async () => {
      const input = { label, forwardTo: forwardTo || null, forwardUserId, access, userIds };
      const r = row ? await updatePhoneNumber(row.id, input) : await addPhoneNumber({ sid, ...input });
      if (!r.ok) return void toast.error(r.error);
      toast.success(row ? "Number saved" : "Number added. Its calls and texts now come to the CRM.");
      onClose();
    });

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={row ? `Edit ${row.label}` : "Add a number"}
      description={row ? formatPhone(row.number) : "Pick a number from your Twilio account. Adding it points its calls and texts at the CRM."}
      footer={
        <>
          {row ? (
            <Button
              variant="ghost"
              className="mr-auto text-error"
              loading={pending}
              onClick={() => {
                if (!confirm(`Stop using ${row.label} here? Its calls and texts stay on the records; Twilio stops sending new ones to the CRM.`)) return;
                start(async () => {
                  const r = await removePhoneNumber(row.id);
                  if (!r.ok) return void toast.error(r.error);
                  toast.success("Number removed");
                  onClose();
                });
              }}
            >
              Remove
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} disabled={!label.trim() || (!row && !sid)} onClick={save}>
            {row ? "Save" : "Add number"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!row ? (
          <Field label="Number">
            {(p) =>
              loading || available === null ? (
                <p className="text-[13px] text-muted">Loading numbers from Twilio…</p>
              ) : available.length ? (
                <Select
                  {...p}
                  value={sid}
                  onChange={(e) => {
                    setSid(e.target.value);
                    const n = available.find((a) => a.sid === e.target.value);
                    if (n && !label) setLabel(n.friendlyName === n.number ? "" : n.friendlyName);
                  }}
                >
                  {available.map((n) => (
                    <option key={n.sid} value={n.sid}>
                      {formatPhone(n.number)}
                      {n.friendlyName !== n.number ? ` · ${n.friendlyName}` : ""}
                      {!n.sms ? " (no texting)" : !n.voice ? " (no calls)" : ""}
                    </option>
                  ))}
                </Select>
              ) : (
                <p className="text-[13px] text-muted">There are no numbers in the Twilio account. Buy one in the Twilio console, then come back.</p>
              )
            }
          </Field>
        ) : null}
        <Field label="Name" hint="What teammates see when picking a number to call or text from.">
          {(p) => <Input {...p} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Main line" />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Forward calls to" optional hint="A cell phone. Leave blank to not take calls.">
            {(p) => <Input {...p} type="tel" value={forwardTo} onChange={(e) => setForwardTo(e.target.value)} placeholder="(303) 555-0123" />}
          </Field>
          <Field label="Who answers" optional hint="Gets the task to write up each call, and texts from unknown numbers.">
            {(p) => <OwnerSelect id={p.id} value={forwardUserId} onChange={setForwardUserId} noneLabel="Nobody" />}
          </Field>
        </div>
        <Field label="Who can call and text from it">
          {(p) => (
            <Select {...p} value={access} onChange={(e) => setAccess(e.target.value as "everyone" | "selected")}>
              <option value="everyone">Everyone who can edit records</option>
              <option value="selected">Only the teammates I pick</option>
            </Select>
          )}
        </Field>
        {access === "selected" ? (
          <div className="grid gap-1.5 sm:grid-cols-2">
            {team
              .filter((m) => m.active && m.role !== "viewer")
              .map((m) => (
                <Checkbox
                  key={m.id}
                  checked={userIds.includes(m.id)}
                  onChange={(e) => setUserIds((list) => (e.target.checked ? [...list, m.id] : list.filter((x) => x !== m.id)))}
                  label={<span className="text-[13px]">{m.name}</span>}
                />
              ))}
            <p className="text-fine sm:col-span-2">Admins can always use every number.</p>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
