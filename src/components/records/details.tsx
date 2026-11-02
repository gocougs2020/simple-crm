"use client";

import Link from "next/link";
import { useState } from "react";
import { BriefcaseIcon, BuildingOffice2Icon, PlusIcon } from "@heroicons/react/20/solid";
import { updateClient } from "@/actions/clients";
import { updateOrganization, updatePerson } from "@/actions/records";
import { CategoryBadge, Chip, HealthBadge } from "@/components/clients/client-controls";
import { useApp } from "@/components/app-context";
import { openCreate } from "@/components/shell/create-store";
import { Avatar } from "@/components/ui/avatar";
import { StatusBadge, Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/field";
import type { schema } from "@/db";
import { churnReasons, clientHealthLabels, clientHealths, type ClientCategory, type ClientHealth, type EntityType } from "@/lib/constants";
import { formatDateOnly, formatPhoneInput, parseMoney, personName } from "@/lib/format";
import { CustomFieldInput, formatCustomValue } from "./custom-field-input";
import { InlineField, SideCard } from "./inline-field";
import { OwnerSelect } from "./owner-select";
import { RecordPicker, type PickerValue } from "./record-picker";

type Person = typeof schema.people.$inferSelect;
type Organization = typeof schema.organizations.$inferSelect;
type Client = typeof schema.clients.$inferSelect;

const ok = <T,>(r: { ok: true; data: T } | { ok: false; error: string }) => (r.ok ? { ok: true as const } : r);

function text(save: (v: string | null) => Promise<{ ok: true } | { ok: false; error: string }>, opts: { type?: string; placeholder?: string; format?: (v: string) => string } = {}) {
  return {
    editor: ({ value, setValue, autoFocus }: { value: string | null; setValue: (v: string | null) => void; autoFocus: true }) => (
      <Input type={opts.type} value={value ?? ""} onChange={(e) => setValue(opts.format ? opts.format(e.target.value) : e.target.value)} autoFocus={autoFocus} placeholder={opts.placeholder} className="h-8 text-[13.5px]" />
    ),
    onSave: (v: string | null) => save(v?.trim() || null),
  };
}

function OwnerField({ value, onSave }: { value: string | null; onSave: (v: string | null) => Promise<{ ok: true } | { ok: false; error: string }> }) {
  const { member } = useApp();
  const m = member(value);
  return (
    <InlineField
      label="Owner"
      value={value}
      empty="No owner"
      display={
        m ? (
          <span className="flex items-center gap-1.5">
            <Avatar name={m.name} size="xs" />
            {m.name}
          </span>
        ) : undefined
      }
      editor={({ value, commit }) => <OwnerSelect value={value} onChange={(v) => commit(v)} className="[&_select]:h-8" />}
      onSave={onSave}
    />
  );
}

/** Custom fields for a record, edited one at a time like the built-in ones. */
function CustomFieldRows({ entity, values, onSave }: { entity: EntityType; values: Record<string, unknown>; onSave: (key: string, v: unknown) => Promise<{ ok: true } | { ok: false; error: string }> }) {
  const { customFields, money } = useApp();
  return (
    <>
      {customFields
        .filter((f) => f.entityType === entity)
        .map((f) => (
          <InlineField
            key={f.id}
            label={f.label}
            value={values[f.key] as never}
            multiline={f.type === "longtext"}
            display={
              f.type === "url" && values[f.key] ? (
                <a href={String(values[f.key])} target="_blank" rel="noopener noreferrer nofollow" className="underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>
                  {String(values[f.key]).replace(/^https?:\/\//, "")}
                </a>
              ) : (
                formatCustomValue(f, values[f.key] as never, money) || undefined
              )
            }
            editor={({ value, setValue, commit }) =>
              f.type === "select" || f.type === "checkbox" ? (
                <CustomFieldInput field={f} value={value} onChange={(v) => commit(v as never)} />
              ) : (
                <CustomFieldInput field={f} value={value} onChange={(v) => setValue(v as never)} />
              )
            }
            onSave={(v) => onSave(f.key, v)}
          />
        ))}
    </>
  );
}

// ─── Person ──────────────────────────────────────────────────────────────

export function PersonDetails({ person, organization }: { person: Person; organization: Organization | null }) {
  const save = (patch: Parameters<typeof updatePerson>[1]) => updatePerson(person.id, patch).then(ok);
  return (
    <SideCard title="Details">
      <dl>
        <InlineField
          label="Email"
          value={person.email}
          copy={person.email}
          display={
            person.email ? (
              <a href={`mailto:${person.email}`} className="underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>
                {person.email}
              </a>
            ) : undefined
          }
          {...text((email) => save({ email }), { type: "email" })}
        />
        <InlineField
          label="Phone"
          value={person.phone}
          copy={person.phone}
          display={
            person.phone ? (
              <a href={`tel:${person.phone.replace(/[^\d+]/g, "")}`} className="underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>
                {person.phone}
              </a>
            ) : undefined
          }
          {...text((phone) => save({ phone }), { type: "tel", format: formatPhoneInput })}
        />
        <InlineField label="Job title" value={person.title} {...text((title) => save({ title }))} />
        <InlineField<PickerValue>
          label="Organization"
          value={organization ? { record: { id: organization.id, label: organization.name } } : null}
          empty="Add organization"
          display={
            organization ? (
              <Link href={`/organizations/${organization.id}`} className="underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>
                {organization.name}
              </Link>
            ) : undefined
          }
          editor={({ value, commit }) => <RecordPicker kind="organization" value={value} onChange={(v) => commit(v)} allowCreate={false} autoFocus />}
          onSave={(v) => save({ organizationId: v && "record" in v ? v.record.id : null })}
        />
        <OwnerField value={person.ownerId} onSave={(ownerId) => save({ ownerId })} />
        <InlineField<string[]>
          label="Tags"
          value={person.tags}
          empty="Add tags"
          display={
            <span className="flex flex-wrap gap-1">
              {person.tags.map((t) => (
                <Tag key={t}>{t}</Tag>
              ))}
            </span>
          }
          editor={({ value, setValue }) => <TagEditor value={value} onChange={setValue} />}
          onSave={(tags) => save({ tags })}
        />
        <InlineField<boolean>
          label="Email opt-in"
          value={person.marketingOptIn && !person.unsubscribedAt}
          display={person.unsubscribedAt ? <StatusBadge tone="neutral">Unsubscribed</StatusBadge> : person.marketingOptIn ? "Gets campaigns" : "No campaigns"}
          editor={({ value, commit }) => <Checkbox checked={value} onChange={(e) => commit(e.target.checked)} label="Include in email campaigns" autoFocus />}
          onSave={(marketingOptIn) => save({ marketingOptIn })}
          readOnly={!!person.unsubscribedAt}
        />
        <CustomFieldRows entity="person" values={person.custom} onSave={(key, v) => save({ custom: { [key]: v } })} />
      </dl>
    </SideCard>
  );
}

function TagEditor({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const t = draft.trim().toLowerCase();
    if (t && !value.includes(t)) onChange([...value, t]);
    setDraft("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border border-ring bg-surface px-1.5 py-1 ring-1 ring-ring">
      {value.map((t) => (
        <Tag key={t} onRemove={() => onChange(value.filter((x) => x !== t))}>
          {t}
        </Tag>
      ))}
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === ",") && draft.trim()) {
            e.preventDefault();
            e.stopPropagation();
            add();
          }
          if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={add}
        placeholder={value.length ? "" : "Type and press Enter"}
        className="h-6 min-w-24 flex-1 bg-transparent text-[13px] outline-none"
        aria-label="Add tag"
      />
    </div>
  );
}

// ─── Organization ────────────────────────────────────────────────────────

export function OrganizationDetails({ org }: { org: Organization }) {
  const save = (patch: Parameters<typeof updateOrganization>[1]) => updateOrganization(org.id, patch).then(ok);
  return (
    <SideCard title="Details">
      <dl>
        <InlineField label="Name" value={org.name} {...text((name) => save({ name: name ?? "" }))} />
        <InlineField
          label="Website"
          value={org.domain}
          display={
            org.domain ? (
              <a href={`https://${org.domain}`} target="_blank" rel="noopener noreferrer nofollow" className="underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>
                {org.domain}
              </a>
            ) : undefined
          }
          {...text((domain) => save({ domain }), { placeholder: "acme.com" })}
        />
        <InlineField label="Phone" value={org.phone} copy={org.phone} {...text((phone) => save({ phone }), { type: "tel", format: formatPhoneInput })} />
        <InlineField label="Industry" value={org.industry} {...text((industry) => save({ industry }))} />
        <InlineField
          label="Address"
          value={org.address}
          multiline
          editor={({ value, setValue }) => <Textarea value={value ?? ""} onChange={(e) => setValue(e.target.value)} autoFocus rows={2} className="text-[13.5px]" />}
          onSave={(address) => save({ address: address?.trim() || null })}
        />
        <OwnerField value={org.ownerId} onSave={(ownerId) => save({ ownerId })} />
        <CustomFieldRows entity="organization" values={org.custom} onSave={(key, v) => save({ custom: { [key]: v } })} />
      </dl>
    </SideCard>
  );
}

// ─── Client ──────────────────────────────────────────────────────────────

const dateEditor = ({ value, setValue }: { value: string | null; setValue: (v: string | null) => void }) => (
  <Input type="date" value={value ?? ""} onChange={(e) => setValue(e.target.value || null)} autoFocus className="h-8 text-[13.5px]" />
);

/** The client's fields. Which ones show depends on the category: what a prospect is worth, how a current client is doing, why a past one left. */
export function ClientDetails({ client, person, organization }: { client: Client; person: Person | null; organization: Organization | null }) {
  const { money, workspace } = useApp();
  const tz = workspace.timezone;
  const save = (patch: Parameters<typeof updateClient>[1]) => updateClient(client.id, patch).then(ok);
  const c = client.category;
  return (
    <SideCard title="Details">
      <dl>
        <InlineField label="Name" value={client.name} {...text((name) => save({ name: name ?? "" }))} />
        {c === "prospective" ? (
          <>
            <InlineField<string>
              label="Potential value"
              value={String(client.value / 100)}
              display={<span className="tabular-nums">{money(client.value)}</span>}
              editor={({ value, setValue }) => <Input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} autoFocus className="h-8 text-[13.5px]" />}
              onSave={async (v) => {
                const cents = parseMoney(v);
                if (cents === null) return { ok: false, error: "Enter the value as a number, like 12,500 or 12.5k." };
                return save({ value: cents });
              }}
            />
            <InlineField label="Expected to sign" value={client.expectedCloseDate} display={client.expectedCloseDate ? formatDateOnly(client.expectedCloseDate, tz) : undefined} editor={dateEditor} onSave={(expectedCloseDate) => save({ expectedCloseDate })} />
          </>
        ) : null}
        {c === "current" ? (
          <InlineField<ClientHealth | null>
            label="Health"
            value={client.health}
            empty="Set health"
            display={client.health ? <HealthBadge health={client.health} /> : undefined}
            editor={({ value, commit }) => (
              <Select value={value ?? ""} onChange={(e) => commit((e.target.value || null) as ClientHealth | null)} autoFocus className="[&_select]:h-8">
                <option value="">Not set</option>
                {clientHealths.map((h) => (
                  <option key={h} value={h}>
                    {clientHealthLabels[h]}
                  </option>
                ))}
              </Select>
            )}
            onSave={(health) => save({ health })}
          />
        ) : null}
        {c !== "prospective" ? <InlineField label="Client since" value={client.startedOn} display={client.startedOn ? formatDateOnly(client.startedOn, tz) : undefined} editor={dateEditor} onSave={(startedOn) => save({ startedOn })} /> : null}
        {c === "past" ? (
          <>
            <InlineField label="Left on" value={client.endedOn} display={client.endedOn ? formatDateOnly(client.endedOn, tz) : undefined} editor={dateEditor} onSave={(endedOn) => save({ endedOn })} />
            <InlineField<string | null>
              label="Why they left"
              value={client.churnReason}
              multiline
              editor={({ value, setValue }) => (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap gap-1">
                    {churnReasons.map((r) => (
                      <Chip key={r} on={value === r} onClick={() => setValue(value === r ? null : r)}>
                        {r}
                      </Chip>
                    ))}
                  </div>
                  <Input value={value ?? ""} onChange={(e) => setValue(e.target.value || null)} autoFocus placeholder="Or write your own" className="h-8 text-[13.5px]" />
                </div>
              )}
              onSave={(churnReason) => save({ churnReason: churnReason?.trim() || null })}
            />
            <InlineField<boolean>
              label="Win back"
              value={client.openToReturn}
              display={client.openToReturn ? "Open to coming back" : "Not interested"}
              editor={({ value, commit }) => <Checkbox checked={value} onChange={(e) => commit(e.target.checked)} label="Open to coming back" autoFocus />}
              onSave={(openToReturn) => save({ openToReturn })}
            />
          </>
        ) : null}
        <InlineField<PickerValue>
          label="Contact"
          value={person ? { record: { id: person.id, label: personName(person) } } : null}
          empty="Add contact"
          display={
            person ? (
              <Link href={`/people/${person.id}`} className="underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>
                {personName(person)}
              </Link>
            ) : undefined
          }
          editor={({ value, commit }) => <RecordPicker kind="person" value={value} onChange={(v) => commit(v)} allowCreate={false} autoFocus />}
          onSave={(v) => save({ personId: v && "record" in v ? v.record.id : null })}
        />
        <InlineField<PickerValue>
          label="Organization"
          value={organization ? { record: { id: organization.id, label: organization.name } } : null}
          empty="Add organization"
          display={
            organization ? (
              <Link href={`/organizations/${organization.id}`} className="underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>
                {organization.name}
              </Link>
            ) : undefined
          }
          editor={({ value, commit }) => <RecordPicker kind="organization" value={value} onChange={(v) => commit(v)} allowCreate={false} autoFocus />}
          onSave={(v) => save({ organizationId: v && "record" in v ? v.record.id : null })}
        />
        <OwnerField value={client.ownerId} onSave={(ownerId) => save({ ownerId })} />
        <InlineField<string[]>
          label="Tags"
          value={client.tags}
          empty="Add tags"
          display={
            <span className="flex flex-wrap gap-1">
              {client.tags.map((t) => (
                <Tag key={t}>{t}</Tag>
              ))}
            </span>
          }
          editor={({ value, setValue }) => <TagEditor value={value} onChange={setValue} />}
          onSave={(tags) => save({ tags })}
        />
        <CustomFieldRows entity="client" values={client.custom} onSave={(key, v) => save({ custom: { [key]: v } })} />
      </dl>
    </SideCard>
  );
}

// ─── Related lists ───────────────────────────────────────────────────────

export type RelatedClient = { id: string; name: string; category: ClientCategory; value: number; mrr: number | string; stageName: string | null };

const categoryOrder: Record<ClientCategory, number> = { current: 0, prospective: 1, past: 2 };

export function RelatedClients({ clients, create }: { clients: RelatedClient[]; create: Parameters<typeof openCreate>[0] }) {
  const { money } = useApp();
  return (
    <SideCard
      title={
        <>
          Clients <span className="font-medium text-muted tabular-nums">{clients.length || ""}</span>
        </>
      }
      action={
        <Button size="sm" variant="ghost" className="-mr-2" onClick={() => openCreate(create)}>
          <PlusIcon />
          Client
        </Button>
      }
    >
      {clients.length ? (
        <ul className="-mx-2">
          {[...clients]
            .sort((a, b) => categoryOrder[a.category] - categoryOrder[b.category])
            .map((d) => (
              <li key={d.id}>
                <Link href={`/clients/${d.id}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sunken">
                  <BriefcaseIcon className="size-4 shrink-0 text-faint" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-primary">{d.name}</span>
                    <span className="block truncate text-[11.5px] text-muted">{d.stageName}</span>
                  </span>
                  <CategoryBadge category={d.category} />
                  <span className="text-[12.5px] text-secondary tabular-nums">
                    {d.category === "prospective" ? money(d.value) : Number(d.mrr) ? `${money(Number(d.mrr))}/mo` : null}
                  </span>
                </Link>
              </li>
            ))}
        </ul>
      ) : (
        <p className="py-1 text-[12.5px] text-muted">Not a client yet.</p>
      )}
    </SideCard>
  );
}

export function RelatedPeople({ people, organization }: { people: Person[]; organization: { id: string; name: string } }) {
  return (
    <SideCard
      title={
        <>
          People <span className="font-medium text-muted tabular-nums">{people.length || ""}</span>
        </>
      }
      action={
        <Button size="sm" variant="ghost" className="-mr-2" onClick={() => openCreate({ kind: "person", defaults: { organizationId: organization.id, organizationName: organization.name } })}>
          <PlusIcon />
          Person
        </Button>
      }
    >
      {people.length ? (
        <ul className="-mx-2">
          {people.map((p) => (
            <li key={p.id}>
              <Link href={`/people/${p.id}`} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-sunken">
                <Avatar name={personName(p)} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-primary">{personName(p)}</span>
                  <span className="block truncate text-[11.5px] text-muted">{p.title ?? p.email ?? ""}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-1 text-[12.5px] text-muted">No people yet.</p>
      )}
    </SideCard>
  );
}

export function OrganizationCard({ org }: { org: Organization }) {
  return (
    <SideCard title="Organization">
      <Link href={`/organizations/${org.id}`} className="-mx-2 flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-sunken">
        <span className="flex size-8 items-center justify-center rounded-md bg-sunken">
          <BuildingOffice2Icon className="size-4 text-muted" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium text-primary">{org.name}</span>
          <span className="block truncate text-[11.5px] text-muted">{org.domain ?? org.industry ?? ""}</span>
        </span>
      </Link>
    </SideCard>
  );
}

export function PersonCard({ person, title = "Person" }: { person: Person; title?: string }) {
  return (
    <SideCard title={title}>
      <Link href={`/people/${person.id}`} className="-mx-2 flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-sunken">
        <Avatar name={personName(person)} size="md" />
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium text-primary">{personName(person)}</span>
          <span className="block truncate text-[11.5px] text-muted">{[person.title, person.email].filter(Boolean).join(" · ")}</span>
        </span>
      </Link>
      <div className="mt-1 flex gap-1 text-[12px]">
        {person.email ? (
          <a href={`mailto:${person.email}`} className="rounded-md px-2 py-1 text-muted hover:bg-sunken hover:text-primary">
            Email
          </a>
        ) : null}
        {person.phone ? (
          <a href={`tel:${person.phone.replace(/[^\d+]/g, "")}`} className="rounded-md px-2 py-1 text-muted hover:bg-sunken hover:text-primary">
            Call {person.phone}
          </a>
        ) : null}
      </div>
    </SideCard>
  );
}

