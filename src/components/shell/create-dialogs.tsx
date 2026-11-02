"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { createClient } from "@/actions/clients";
import { createOrganization, createPerson } from "@/actions/records";
import { Chip } from "@/components/clients/client-controls";
import { useApp } from "@/components/app-context";
import { CustomFieldInput } from "@/components/records/custom-field-input";
import { OwnerSelect } from "@/components/records/owner-select";
import { RecordPicker, type PickerValue } from "@/components/records/record-picker";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { clientCategories, clientCategoryLabels, type ClientCategory, type EntityType } from "@/lib/constants";
import { formatPhoneInput, parseMoney } from "@/lib/format";
import { openCreate, useCreateRequest, type CreateRequest } from "./create-store";

/** Mounted once in the shell; opens whichever quick-create form was requested. */
export function CreateDialogs() {
  const req = useCreateRequest();
  const close = () => openCreate(null);
  // Keyed by the request so each open starts with a fresh form.
  return (
    <>
      {req?.kind === "person" ? <PersonDialog key={JSON.stringify(req)} req={req} onClose={close} /> : null}
      {req?.kind === "organization" ? <OrganizationDialog key={JSON.stringify(req)} req={req} onClose={close} /> : null}
      {req?.kind === "client" ? <ClientDialog key={JSON.stringify(req)} req={req} onClose={close} /> : null}
    </>
  );
}

function CustomFields({ entity, values, onChange }: { entity: EntityType; values: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const { customFields } = useApp();
  const fields = customFields.filter((f) => f.entityType === entity);
  if (!fields.length) return null;
  return (
    <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
      {fields.map((f) =>
        f.type === "checkbox" ? (
          <div key={f.id} className="flex items-end pb-2">
            <CustomFieldInput field={f} value={values[f.key] as never} onChange={(v) => onChange({ ...values, [f.key]: v })} />
          </div>
        ) : (
          <Field key={f.id} label={f.label} optional className={f.type === "longtext" || f.type === "multiselect" ? "sm:col-span-2" : undefined}>
            {(p) => <CustomFieldInput id={p.id} field={f} value={values[f.key] as never} onChange={(v) => onChange({ ...values, [f.key]: v })} />}
          </Field>
        ),
      )}
    </div>
  );
}

function useSubmit<T>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, onDone: (data: T) => void) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await fn();
      if (r.ok) onDone(r.data);
      else setError(r.error);
    });
  };
  return { pending, error, submit };
}

function FormError({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="mb-4 rounded-md border border-error-border bg-error-surface px-3 py-2 text-[13px] text-error">
      {error}
    </p>
  ) : null;
}

/** "Saved" toast with a link, plus an option to stay put when creating several in a row. */
function useCreated(path: string, noun: string, onClose: () => void) {
  const router = useRouter();
  return (id: string, label: string, open: boolean) => {
    onClose();
    if (open) router.push(`${path}/${id}`);
    else toast.success(`${noun} “${label}” added`, { label: "Open", onClick: () => router.push(`${path}/${id}`) });
  };
}

function PersonDialog({ req, onClose }: { req: Extract<CreateRequest, { kind: "person" }>; onClose: () => void }) {
  const { viewer } = useApp();
  const d = req.defaults ?? {};
  const [firstName, setFirstName] = useState(d.firstName ?? "");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [title, setTitle] = useState("");
  const [org, setOrg] = useState<PickerValue>(d.organizationId ? { record: { id: d.organizationId, label: d.organizationName ?? "" } } : null);
  const [ownerId, setOwnerId] = useState<string | null>(viewer.id);
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [openAfter, setOpenAfter] = useState(true);
  const done = useCreated("/people", "Person", onClose);
  const { pending, error, submit } = useSubmit(
    () =>
      createPerson({
        firstName,
        lastName,
        email,
        phone,
        title,
        ownerId,
        organizationId: org && "record" in org ? org.record.id : null,
        newOrganizationName: org && "create" in org ? org.create : undefined,
        custom,
      }),
    (r) => done(r.id, [firstName, lastName].filter(Boolean).join(" "), openAfter),
  );
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New person"
      size="lg"
      footer={<Footer pending={pending} form="create-person" label="Add person" openAfter={openAfter} setOpenAfter={setOpenAfter} onCancel={onClose} />}
    >
      <form id="create-person" onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name">{(p) => <Input {...p} value={firstName} onChange={(e) => setFirstName(e.target.value)} required autoComplete="off" />}</Field>
          <Field label="Last name" optional>
            {(p) => <Input {...p} value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="off" />}
          </Field>
          <Field label="Email" optional>
            {(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />}
          </Field>
          <Field label="Phone" optional>
            {(p) => <Input {...p} type="tel" value={phone} onChange={(e) => setPhone(formatPhoneInput(e.target.value))} autoComplete="off" />}
          </Field>
          <Field label="Organization" optional>
            {(p) => <RecordPicker id={p.id} kind="organization" value={org} onChange={setOrg} />}
          </Field>
          <Field label="Job title" optional>
            {(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" />}
          </Field>
          <Field label="Owner">{(p) => <OwnerSelect id={p.id} value={ownerId} onChange={setOwnerId} />}</Field>
        </div>
        <CustomFields entity="person" values={custom} onChange={setCustom} />
      </form>
    </Dialog>
  );
}

function OrganizationDialog({ req, onClose }: { req: Extract<CreateRequest, { kind: "organization" }>; onClose: () => void }) {
  const { viewer } = useApp();
  const [name, setName] = useState(req.defaults?.name ?? "");
  const [domain, setDomain] = useState("");
  const [phone, setPhone] = useState("");
  const [industry, setIndustry] = useState("");
  const [address, setAddress] = useState("");
  const [ownerId, setOwnerId] = useState<string | null>(viewer.id);
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [openAfter, setOpenAfter] = useState(true);
  const done = useCreated("/organizations", "Organization", onClose);
  const { pending, error, submit } = useSubmit(() => createOrganization({ name, domain, phone, industry, address, ownerId, custom }), (r) => done(r.id, name, openAfter));
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New organization"
      size="lg"
      footer={<Footer pending={pending} form="create-org" label="Add organization" openAfter={openAfter} setOpenAfter={setOpenAfter} onCancel={onClose} />}
    >
      <form id="create-org" onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" className="sm:col-span-2">
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} required autoComplete="off" />}
          </Field>
          <Field label="Website" optional>
            {(p) => <Input {...p} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="acme.com" autoComplete="off" />}
          </Field>
          <Field label="Phone" optional>
            {(p) => <Input {...p} type="tel" value={phone} onChange={(e) => setPhone(formatPhoneInput(e.target.value))} autoComplete="off" />}
          </Field>
          <Field label="Industry" optional>
            {(p) => <Input {...p} value={industry} onChange={(e) => setIndustry(e.target.value)} autoComplete="off" />}
          </Field>
          <Field label="Owner">{(p) => <OwnerSelect id={p.id} value={ownerId} onChange={setOwnerId} />}</Field>
          <Field label="Address" optional className="sm:col-span-2">
            {(p) => <Input {...p} value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="off" />}
          </Field>
        </div>
        <CustomFields entity="organization" values={custom} onChange={setCustom} />
      </form>
    </Dialog>
  );
}

function ClientDialog({ req, onClose }: { req: Extract<CreateRequest, { kind: "client" }>; onClose: () => void }) {
  const { viewer, pipelines, workspace, catalog, stage } = useApp();
  const d = req.defaults ?? {};
  const [category, setCategory] = useState<ClientCategory>(d.category ?? (d.stageId ? (stage(d.stageId)?.pipeline.category ?? "prospective") : "prospective"));
  const options = pipelines.filter((p) => p.category === category);
  const firstStage = (c: ClientCategory) => {
    const list = pipelines.filter((p) => p.category === c);
    return (list.find((p) => p.id === viewer.prefs.clientPipelines?.[c]) ?? list[0])?.stages[0]?.id ?? "";
  };
  const [stageId, setStageId] = useState(d.stageId ?? firstStage(category));
  const [name, setName] = useState(d.name ?? "");
  const [nameTouched, setNameTouched] = useState(!!d.name);
  const [value, setValue] = useState("");
  const [person, setPerson] = useState<PickerValue>(d.personId ? { record: { id: d.personId, label: d.personName ?? "" } } : null);
  const [org, setOrg] = useState<PickerValue>(d.organizationId ? { record: { id: d.organizationId, label: d.organizationName ?? "" } } : null);
  const [date, setDate] = useState("");
  const [serviceIds, setServiceIds] = useState<string[]>([]);
  const [ownerId, setOwnerId] = useState<string | null>(viewer.id);
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [openAfter, setOpenAfter] = useState(false);
  const done = useCreated("/clients", "Client", onClose);
  const cents = parseMoney(value);

  // The client is usually the organization, or the person when they're on their own.
  const label = (v: PickerValue) => (v ? ("record" in v ? v.record.label : v.create) : "");
  const effectiveName = nameTouched ? name : label(org) || label(person);

  const { pending, error, submit } = useSubmit(
    () =>
      cents === null
        ? Promise.resolve({ ok: false as const, error: "Enter the value as a number, like 12,500 or 12.5k." })
        : createClient({
            name: effectiveName,
            category,
            value: cents,
            stageId: stageId || null,
            ownerId,
            expectedCloseDate: category === "prospective" ? date || null : null,
            startedOn: category === "current" ? date || null : null,
            endedOn: category === "past" ? date || null : null,
            serviceIds,
            personId: person && "record" in person ? person.record.id : null,
            newPersonName: person && "create" in person ? person.create : undefined,
            organizationId: org && "record" in org ? org.record.id : null,
            newOrganizationName: org && "create" in org ? org.create : undefined,
            custom,
          }),
    (r) => done(r.id, effectiveName, openAfter),
  );

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New client"
      size="lg"
      footer={<Footer pending={pending} form="create-client" label="Add client" openAfter={openAfter} setOpenAfter={setOpenAfter} onCancel={onClose} />}
    >
      <form id="create-client" onSubmit={submit} className="flex flex-col gap-4">
        <FormError error={error} />
        <div role="radiogroup" aria-label="Category" className="grid grid-cols-3 gap-2">
          {clientCategories.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={category === c}
              onClick={() => {
                setCategory(c);
                setStageId(firstStage(c));
              }}
              className={`rounded-lg border px-3 py-2 text-left transition-colors ${category === c ? "border-accent bg-accent-soft" : "border-line hover:border-line-strong"}`}
            >
              <span className="block text-[13.5px] font-medium text-primary">{clientCategoryLabels[c].one}</span>
              <span className="mt-0.5 block text-[11.5px] leading-snug text-muted">{clientCategoryLabels[c].hint}</span>
            </button>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Contact" optional>
            {(p) => (
              <RecordPicker
                id={p.id}
                kind="person"
                value={person}
                autoFocus={!d.personId && !d.organizationId}
                onChange={(v) => {
                  setPerson(v);
                  // Picking someone who works somewhere fills in their organization.
                  if (v && "record" in v && v.record.organizationId && !org) setOrg({ record: { id: v.record.organizationId, label: v.record.detail ?? "" } });
                }}
              />
            )}
          </Field>
          <Field label="Organization" optional>
            {(p) => <RecordPicker id={p.id} kind="organization" value={org} onChange={setOrg} />}
          </Field>
          <Field label="Name" className="sm:col-span-2" hint="Usually the company, or the person if they're on their own.">
            {(p) => (
              <Input
                {...p}
                value={effectiveName}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
                required
                autoComplete="off"
              />
            )}
          </Field>
          {category === "prospective" ? (
            <Field label={`Potential value (${workspace.currency})`} error={cents === null ? "Enter a number, like 12,500 or 12.5k." : null} optional>
              {(p) => <Input {...p} inputMode="decimal" placeholder="0" value={value} onChange={(e) => setValue(e.target.value)} />}
            </Field>
          ) : null}
          <Field label={category === "prospective" ? "Expected to sign" : category === "current" ? "Client since" : "Left on"} optional>
            {(p) => <Input {...p} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
          </Field>
          <Field label="Stage">
            {(p) =>
              options.length ? (
                <Select id={p.id} value={stageId} onChange={(e) => setStageId(e.target.value)}>
                  {options.map((pl) => (
                    <optgroup key={pl.id} label={pl.name}>
                      {pl.stages.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              ) : (
                <p id={p.id} className="py-2 text-[13px] text-error">
                  Add a pipeline for {clientCategoryLabels[category].one.toLowerCase()} clients in Settings → Pipelines first.
                </p>
              )
            }
          </Field>
          <Field label="Owner">{(p) => <OwnerSelect id={p.id} value={ownerId} onChange={setOwnerId} />}</Field>
          {category !== "prospective" && catalog.some((s) => !s.archivedAt) ? (
            <div className="sm:col-span-2">
              <p className="mb-1.5 text-[13px] font-medium text-primary">
                {category === "current" ? "Services they use" : "Services they had"} <span className="font-normal text-muted">(optional)</span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {catalog
                  .filter((s) => !s.archivedAt)
                  .map((s) => (
                    <Chip key={s.id} on={serviceIds.includes(s.id)} onClick={() => setServiceIds(serviceIds.includes(s.id) ? serviceIds.filter((x) => x !== s.id) : [...serviceIds, s.id])}>
                      {s.name}
                    </Chip>
                  ))}
              </div>
            </div>
          ) : null}
        </div>
        <CustomFields entity="client" values={custom} onChange={setCustom} />
      </form>
    </Dialog>
  );
}

function Footer({ pending, form, label, openAfter, setOpenAfter, onCancel }: { pending: boolean; form: string; label: string; openAfter: boolean; setOpenAfter: (v: boolean) => void; onCancel: () => void }) {
  return (
    <>
      <label className="mr-auto flex cursor-pointer items-center gap-2 text-[13px] text-secondary select-none">
        <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={openAfter} onChange={(e) => setOpenAfter(e.target.checked)} />
        Open after saving
      </label>
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" form={form} variant="primary" loading={pending}>
        {label}
      </Button>
    </>
  );
}
