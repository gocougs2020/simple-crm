"use client";

import { useState, useTransition } from "react";
import { PlusIcon } from "@heroicons/react/20/solid";
import { buyPhoneNumber, deletePhoneNumber, reconnectPhoneNumbers, searchPhoneNumbers, setUpBrowserCalling, updatePhoneNumber } from "@/actions/phone";
import { useApp } from "@/components/app-context";
import { OwnerSelect } from "@/components/records/owner-select";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { formatPhone, matchKey } from "@/lib/phone/numbers";
import { Section } from "./nav";

type NumberRow = { id: string; label: string; number: string; forwardTo: string | null; forwardUserId: string | null; access: "everyone" | "selected"; userIds: string[] };
type Available = { number: string; locality: string | null; region: string | null };

/**
 * Settings → Phone numbers (admins): the numbers the team calls and texts
 * from. Numbers are bought here by area code, so only the CRM's own numbers
 * are ever listed, never the rest of the Twilio account. Each has who may use
 * it and where incoming calls ring; deleting one releases it from Twilio.
 */
export function PhoneSettings({
  configured,
  auth,
  calling,
  numbers,
  cells = [],
}: {
  configured: boolean;
  auth: { via: "api-key" | "auth-token" | null; webhooks: boolean };
  calling: { ready: boolean; fromEnv: boolean; origin: string | null; currentOrigin: string };
  numbers: NumberRow[];
  /** Teammates' cell phones (Settings → Profile), so a forwarding number can say whose it is. */
  cells?: Cell[];
}) {
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState<NumberRow | "new" | null>(null);
  const { member } = useApp();

  if (!configured) {
    return (
      <Section title="Phone numbers" description="Call from the browser, forward incoming calls to a cell phone, and text people from their records.">
        <p className="p-5 text-[13.5px] text-muted">Calling and texting aren&apos;t set up on this deployment. Add TWILIO_ACCOUNT_SID and a Twilio API key (TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET), then redeploy (see docs/PHONE.md).</p>
      </Section>
    );
  }

  const moved = calling.origin && calling.origin !== calling.currentOrigin;
  return (
    <>
      {!auth.webhooks ? (
        <p role="status" className="mb-6 rounded-xl border border-warning-border bg-warning-surface/50 px-4 py-3 text-[13px] text-warning">
          Incoming calls and texts can&apos;t be verified, so they&apos;re refused. Set up a webhook signing key in Twilio and add its secret as TWILIO_WEBHOOK_SECRET, then redeploy (see docs/PHONE.md).
        </p>
      ) : auth.via === "auth-token" ? (
        <p role="status" className="mb-6 rounded-xl border border-line bg-sunken px-4 py-3 text-[13px] text-secondary">
          This deployment signs in to Twilio with the account&apos;s auth token. An API key is safer: it can be revoked on its own and can&apos;t manage the account (see docs/PHONE.md).
        </p>
      ) : null}
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
        description="Numbers bought here for the CRM. Each one's incoming calls ring a cell phone and are logged on whoever called, with a task to write them up. Texts to it land on the sender's record."
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
              Get a number
            </Button>
          </div>
        }
      >
        {numbers.length ? (
          <ul className="divide-y divide-line">
            {numbers.map((n) => {
              const forwardUser = member(n.forwardUserId ?? (n.forwardTo ? cellOwner(cells, n.forwardTo) : null));
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
          <p className="p-5 text-[13.5px] text-muted">No numbers yet. Get one by area code; it can call, text and send pictures.</p>
        )}
      </Section>
      {editing ? <NumberDialog row={editing === "new" ? null : editing} cells={cells} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

type Cell = { userId: string; phone: string };

/** The teammate whose cell phone this is, matched the same way calls are (last 10 digits). */
function cellOwner(cells: Cell[], raw: string) {
  const key = matchKey(raw);
  const owners = key.length >= 7 ? cells.filter((c) => matchKey(c.phone) === key) : [];
  return owners.length === 1 ? owners[0].userId : null;
}

function NumberDialog({ row, cells, onClose }: { row: NumberRow | null; cells: Cell[]; onClose: () => void }) {
  const { team, member } = useApp();
  const [areaCode, setAreaCode] = useState("");
  const [available, setAvailable] = useState<Available[] | null>(null);
  const [picked, setPicked] = useState("");
  const [label, setLabel] = useState(row?.label ?? "");
  const [forwardTo, setForwardTo] = useState(row?.forwardTo ?? "");
  const [forwardUserId, setForwardUserId] = useState<string | null>(row?.forwardUserId ?? null);
  const [access, setAccess] = useState<"everyone" | "selected">(row?.access ?? "everyone");
  const [userIds, setUserIds] = useState<string[]>(row?.userIds ?? []);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const forwardCell = cellOwner(cells, forwardTo);
  const [pending, start] = useTransition();
  const [searching, startSearch] = useTransition();

  const search = () =>
    startSearch(async () => {
      const r = await searchPhoneNumbers(areaCode);
      if (!r.ok) {
        setAvailable(null);
        return void toast.error(r.error);
      }
      setAvailable(r.data);
      setPicked(r.data[0]?.number ?? "");
    });

  const save = () =>
    start(async () => {
      const input = { label, forwardTo: forwardTo || null, forwardUserId, access, userIds };
      if (row) {
        const r = await updatePhoneNumber(row.id, input);
        if (!r.ok) return void toast.error(r.error);
        toast.success("Number saved");
      } else {
        const r = await buyPhoneNumber({ phoneNumber: picked, ...input });
        if (!r.ok) return void toast.error(r.error);
        if (r.data.warning) toast.error(r.data.warning);
        else toast.success(`${formatPhone(picked)} is yours. Its calls and texts now come to the CRM.`);
      }
      onClose();
    });

  if (row && confirmDelete) {
    return (
      <Dialog
        open
        onOpenChange={(o) => !o && onClose()}
        title={`Delete ${row.label}?`}
        description={`${formatPhone(row.number)} is released from your Twilio account for good: it stops taking calls and texts and stops being billed, and someone else may get it later. This can't be undone.`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button
              variant="destructive"
              loading={pending}
              onClick={() =>
                start(async () => {
                  const r = await deletePhoneNumber(row.id);
                  if (!r.ok) return void toast.error(r.error);
                  toast.success(`${row.label} deleted and released from Twilio`);
                  onClose();
                })
              }
            >
              Delete number
            </Button>
          </>
        }
      >
        <p className="text-[13.5px] text-secondary">Calls and texts it already carried stay on the records.</p>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={row ? `Edit ${row.label}` : "Get a number"}
      description={row ? formatPhone(row.number) : "Search an area code for a local number that can call, text and send pictures. Buying it adds a monthly charge to your Twilio account."}
      footer={
        <>
          {row ? (
            <Button variant="ghost" className="mr-auto text-error" onClick={() => setConfirmDelete(true)}>
              Delete number
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} disabled={!label.trim() || (!row && !picked)} onClick={save}>
            {row ? "Save" : picked ? `Buy ${formatPhone(picked)}` : "Buy number"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!row ? (
          <div className="flex flex-col gap-2">
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                search();
              }}
            >
              <Field label="Area code">
                {(p) => <Input {...p} value={areaCode} onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, "").slice(0, 3))} inputMode="numeric" placeholder="303" className="w-28" autoFocus />}
              </Field>
              <Button type="submit" variant="outline" loading={searching} disabled={areaCode.length !== 3}>
                Search
              </Button>
            </form>
            {available?.length ? (
              <fieldset className="flex flex-col gap-1">
                <legend className="mb-1 text-[12px] font-medium text-secondary">Pick a number</legend>
                {available.map((n) => (
                  <label key={n.number} className="flex cursor-pointer items-center gap-2.5 rounded-md border border-line px-3 py-2 text-[13.5px] has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
                    <input type="radio" name="number" value={n.number} checked={picked === n.number} onChange={() => setPicked(n.number)} className="accent-[var(--accent)]" />
                    <span className="font-medium text-primary tabular-nums">{formatPhone(n.number)}</span>
                    <span className="text-muted">{[n.locality, n.region].filter(Boolean).join(", ")}</span>
                  </label>
                ))}
              </fieldset>
            ) : null}
          </div>
        ) : null}
        <Field label="Name" hint="What teammates see when picking a number to call or text from.">
          {(p) => <Input {...p} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Main line" />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Forward calls to" optional hint="A cell phone. Leave blank to not take calls.">
            {(p) => (
              <Input
                {...p}
                type="tel"
                value={forwardTo}
                onChange={(e) => {
                  setForwardTo(e.target.value);
                  const owner = cellOwner(cells, e.target.value);
                  if (owner) setForwardUserId(owner);
                }}
                placeholder="(303) 555-0123"
              />
            )}
          </Field>
          <Field
            label="Who answers"
            optional
            hint={
              forwardCell && member(forwardCell)
                ? `It's ${member(forwardCell)!.name}'s cell, so they get the task to write up each call, and texts from unknown numbers.`
                : "Gets the task to write up each call, and texts from unknown numbers. Left as nobody, they go to the teammate whose cell phone (in their profile) is the forwarding number."
            }
          >
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
