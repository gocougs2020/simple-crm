"use client";

import clsx from "clsx";
import Link from "next/link";
import { StarToggle } from "@/components/phone/contact-actions";
import { useRef, useState, useTransition } from "react";
import { BriefcaseIcon, BuildingOffice2Icon, PlusIcon, SparklesIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { enrichRecord } from "@/actions/agent";
import { agentTasksChanged } from "@/components/agent/task-events";
import { appConfig } from "@/app.config";
import { updateClient } from "@/actions/clients";
import { updateOrganization, updatePerson } from "@/actions/records";
import { CategoryBadge, Chip, HealthBadge } from "@/components/clients/client-controls";
import { useApp } from "@/components/app-context";
import { openCreate } from "@/components/shell/create-store";
import { Avatar } from "@/components/ui/avatar";
import { toast } from "@/components/ui/toast";
import { StatusBadge } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/field";
import type { schema } from "@/db";
import { churnReasons, clientHealthLabels, clientHealths, type ClientCategory, type ClientHealth, type EntityType } from "@/lib/constants";
import { orderPeople } from "@/lib/crm/people-order";
import { formatDateOnly, formatDay, formatPhoneInput, parseMoney, personName } from "@/lib/format";
import { CustomFieldInput, formatCustomValue } from "./custom-field-input";
import { InlineField, SideCard } from "./inline-field";
import { ChildLabelsDialog, LabelChips, LabelPicker, useLabels } from "./labels";
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

/**
 * Changing a linked contact or organization: the search opens with the
 * current name highlighted, so typing looks for another one at once. Taking
 * it off is the last choice in the list.
 */
function pickerEditor(kind: "person" | "organization", noun: string) {
  return function PickerEditor({ value, commit }: { value: PickerValue; commit: (v?: PickerValue) => void }) {
    const current = value && "record" in value ? value.record.label : "";
    return <RecordPicker kind={kind} value={null} initialQuery={current} onChange={(v) => commit(v)} onRemove={current ? () => commit(null) : undefined} removeLabel={`Remove ${noun}`} allowCreate={false} autoFocus />;
  };
}
const organizationEditor = pickerEditor("organization", "organization");
const contactEditor = pickerEditor("person", "contact");

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
      editor={({ value, commit }) => <OwnerSelect value={value} onChange={(v) => commit(v)} className="[&_select]:h-8 pointer-coarse:[&_select]:h-10" />}
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

/**
 * A person's other emails or phones, besides the primary one. Each can be
 * made primary (what the composer, calls, texts and campaigns use) or
 * removed, and more can be added. Making one primary keeps the old primary
 * in the list.
 */
function OtherContacts({
  label,
  kind,
  values,
  primary,
  onSave,
}: {
  label: string;
  kind: "email" | "phone";
  values: string[];
  primary: string | null;
  onSave: (primary: string | null, others: string[]) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, start] = useTransition();
  const noun = kind === "email" ? "email" : "phone";
  const run = (main: string | null, others: string[], done?: () => void) =>
    start(async () => {
      const r = await onSave(main, others);
      if (!r.ok) toast.error(r.error);
      else done?.();
    });
  const add = () => {
    if (pending) return;
    const v = draft.trim();
    const same = (x: string | null) => !!x && x.trim().toLowerCase() === v.toLowerCase();
    if (!v || same(primary) || values.some(same)) {
      setDraft("");
      return setAdding(false);
    }
    // With no primary yet, the first one added becomes it.
    if (!primary) run(v, values, () => (setDraft(""), setAdding(false)));
    else run(primary, [...values, v], () => (setDraft(""), setAdding(false)));
  };
  const action = "rounded px-1.5 py-0.5 text-[12px] text-muted hover:bg-sunken hover:text-primary disabled:opacity-50";
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-start gap-2 py-1 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:py-1.5">
      <dt className="pt-1.5 text-[12.5px] text-muted">{label}</dt>
      <dd className="min-w-0">
        {values.map((v) => (
          <div key={v} className="group/item relative flex min-h-8 flex-wrap items-center gap-x-1">
            <a href={kind === "email" ? `mailto:${v}` : `tel:${v.replace(/[^\d+]/g, "")}`} className="min-w-0 flex-1 truncate text-[13.5px] text-primary underline-offset-2 hover:underline">
              {v}
            </a>
            {/* With a mouse, the actions show over the end of the row on hover, so the address gets the full width. On touch screens they stay in the row. */}
            <span className="flex items-center gap-0.5 rounded-md bg-surface pointer-fine:absolute pointer-fine:top-1/2 pointer-fine:right-0 pointer-fine:-translate-y-1/2 pointer-fine:pl-2 pointer-fine:opacity-0 pointer-fine:transition-opacity pointer-fine:group-hover/item:opacity-100 pointer-fine:focus-within:opacity-100">
            <button
              type="button"
              className={action}
              disabled={pending}
              onClick={() =>
                run(
                  v,
                  [...(primary ? [primary] : []), ...values.filter((x) => x !== v)],
                )
              }
              aria-label={`Make ${v} the primary ${noun}`}
            >
              Make primary
            </button>
            <button
              type="button"
              className={clsx(action, "px-1")}
              disabled={pending}
              onClick={() =>
                run(
                  primary,
                  values.filter((x) => x !== v),
                )
              }
              aria-label={`Remove ${v}`}
            >
              <XMarkIcon className="size-3.5" />
            </button>
            </span>
          </div>
        ))}
        {adding ? (
          <div className="flex items-center gap-1.5">
            <Input
              type={kind === "email" ? "email" : "tel"}
              value={draft}
              onChange={(e) => setDraft(kind === "phone" ? formatPhoneInput(e.target.value) : e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setDraft("");
                  setAdding(false);
                }
              }}
              onBlur={add}
              autoFocus
              aria-label={`Another ${noun}`}
              className="h-8 text-[13.5px]"
            />
            {pending ? <Spinner className="size-4 text-faint" /> : null}
          </div>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className="-mx-2 min-h-8 rounded-md px-2 py-1.5 text-left text-[13.5px] text-faint hover:bg-sunken">
            Add another {noun}
          </button>
        )}
      </dd>
    </div>
  );
}

/**
 * Enrich: the agent looks the record up on the web in the background, fills
 * in the empty fields it's sure of, and leaves a note with everything it
 * found. People and organizations only; clients are the team's own records.
 */
function EnrichButton({ entity, id, name }: { entity: "person" | "organization"; id: string; name: string }) {
  const { services, canEdit } = useApp();
  const [pending, start] = useTransition();
  if (!services.ai.background || !canEdit) return null;
  return (
    <Button
      size="sm"
      variant="ghost"
      className="-mr-2 h-7 pointer-coarse:h-9"
      loading={pending}
      title={`${appConfig.agent.name} looks ${name} up on the web, fills in what it's sure of and adds a note with what it found`}
      onClick={() =>
        start(async () => {
          const r = await enrichRecord(entity, id);
          if (!r.ok) return void toast.error(r.error);
          agentTasksChanged();
          if (r.data.error) return void toast.error(r.data.error);
          toast.success(`Enriching ${name} in the background. A note with what it found shows in the history when it's done.`);
        })
      }
    >
      <SparklesIcon aria-hidden />
      Enrich
    </Button>
  );
}

export function PersonDetails({ person, organization }: { person: Person; organization: Organization | null }) {
  const { comms, workspace } = useApp();
  const save = (patch: Parameters<typeof updatePerson>[1]) => updatePerson(person.id, patch).then(ok);
  return (
    <SideCard title="Details" action={person.archivedAt ? null : <EnrichButton entity="person" id={person.id} name={personName(person)} />}>
      <dl>
        <InlineField
          label="Name"
          value={personName(person)}
          {...text((name) => {
            const [firstName = "", ...rest] = (name ?? "").split(/\s+/);
            return save({ firstName, lastName: rest.join(" ") || null });
          })}
        />
        <OwnerField value={person.ownerId} onSave={(ownerId) => save({ ownerId })} />
        <InlineField
          label={person.otherEmails.length ? "Primary email" : "Email"}
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
          label={person.otherPhones.length ? "Primary phone" : "Phone"}
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
        <OtherContacts
          label="Other emails"
          kind="email"
          values={person.otherEmails}
          primary={person.email}
          onSave={(main, others) => save({ email: main, otherEmails: others })}
        />
        <OtherContacts
          label="Other phones"
          kind="phone"
          values={person.otherPhones}
          primary={person.phone}
          onSave={(main, others) => save({ phone: main, otherPhones: others })}
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
          editor={organizationEditor}
          onSave={(v) => save({ organizationId: v && "record" in v ? v.record.id : null })}
        />
        <LabelsField value={person.tags} carried={organization?.tags.length ? { names: organization.tags, from: organization.name } : null} onSave={(tags) => save({ tags })} />
        <InlineField<boolean>
          label="Email opt-in"
          value={person.marketingOptIn && !person.unsubscribedAt}
          display={
            person.unsubscribedAt ? (
              <StatusBadge tone="neutral">Unsubscribed</StatusBadge>
            ) : person.emailBouncedAt ? (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <StatusBadge tone="error">Address bounced</StatusBadge>
                <span className="text-[12px] text-muted">Campaigns skip them until the email changes</span>
              </span>
            ) : person.marketingOptIn ? (
              "Gets campaigns"
            ) : (
              "No campaigns"
            )
          }
          editor={({ value, commit }) => <Checkbox checked={value} onChange={(e) => commit(e.target.checked)} label="Include in email campaigns" autoFocus />}
          onSave={(marketingOptIn) => save({ marketingOptIn })}
          readOnly={!!person.unsubscribedAt}
        />
        {comms.phone ? (
          <InlineField<boolean>
            label="Marketing texts"
            value={!!person.textConsentAt}
            display={
              person.textOptOutAt ? (
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <StatusBadge tone="neutral">Replied STOP</StatusBadge>
                  <span className="text-[12px] text-muted">No texts until they reply START</span>
                </span>
              ) : person.textConsentAt ? (
                `Agreed ${formatDay(person.textConsentAt, workspace.timezone)}`
              ) : (
                "Not agreed"
              )
            }
            editor={({ value, commit }) => <Checkbox checked={value} onChange={(e) => commit(e.target.checked)} label="They agreed to get marketing texts" autoFocus />}
            onSave={(textConsent) => save({ textConsent })}
            readOnly={!!person.textOptOutAt}
          />
        ) : null}
        <CustomFieldRows entity="person" values={person.custom} onSave={(key, v) => save({ custom: { [key]: v } })} />
      </dl>
    </SideCard>
  );
}

/**
 * A record's labels: chips that explain themselves on hover, and a dropdown
 * of the workspace's labels to change them. `carried` are the labels a person
 * gets from their organization: shown, but changed on the organization.
 */
function LabelsField({ value, carried, onSave }: { value: string[]; carried?: { names: string[]; from: string } | null; onSave: (tags: string[]) => Promise<{ ok: true } | { ok: false; error: string }> }) {
  const { shown } = useLabels();
  // The dropdown closing and a click elsewhere on the page can both ask to save in the same moment: one request serves both.
  type Saved = { ok: true } | { ok: false; error: string };
  const saving = useRef<Promise<Saved> | null>(null);
  const saveOnce = (tags: string[]) =>
    (saving.current ??= onSave(tags).finally(() => {
      saving.current = null;
    }));
  // "Add labels" when nothing shows: a record with only hidden labels, or none of its own and none carried.
  const anything = shown(value).length || (carried ? shown(carried.names).length : 0);
  return (
    <InlineField<string[]>
      label="Labels"
      value={value}
      filled={!!anything}
      empty="Add labels"
      display={<LabelChips names={value} carried={carried} />}
      editor={({ setValue, commit }) => <LabelPicker value={value} onChange={setValue} onDone={(next) => commit(next)} />}
      onSave={saveOnce}
    />
  );
}

// ─── Organization ────────────────────────────────────────────────────────

export function OrganizationDetails({ org, parent, childCount = 0 }: { org: Organization; parent: { id: string; name: string } | null; childCount?: number }) {
  const { parentOrganizations } = useApp();
  // By name; the current one stays in the list even if it was archived or unmarked since.
  const choices = [...parentOrganizations.filter((p) => p.id !== org.id), ...(parent && !parentOrganizations.some((p) => p.id === parent.id) ? [parent] : [])].sort((a, b) => a.name.localeCompare(b.name));
  const save = (patch: Parameters<typeof updateOrganization>[1]) => updateOrganization(org.id, patch).then(ok);
  // Labels just added to a parent organization, waiting on whether the organizations that are part of it get them too.
  const [forChildren, setForChildren] = useState<string[] | null>(null);
  const saveLabels = async (tags: string[]) => {
    const r = await save({ tags });
    const added = tags.filter((t) => !org.tags.includes(t));
    if (r.ok && org.isParent && childCount && added.length) setForChildren(added);
    return r;
  };
  return (
    <>
      <SideCard title="Details" action={org.archivedAt ? null : <EnrichButton entity="organization" id={org.id} name={org.name} />}>
        <dl>
          <InlineField label="Name" value={org.name} {...text((name) => save({ name: name ?? "" }))} />
          <OwnerField value={org.ownerId} onSave={(ownerId) => save({ ownerId })} />
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
          {/* A parent organization isn't part of another, so it has no parent to pick. */}
          {org.isParent ? null : (
            <InlineField<string | null>
              label="Parent organization"
              value={org.parentId}
              empty="Add parent organization"
              display={
                parent ? (
                  <Link href={`/organizations/${parent.id}`} className="underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>
                    {parent.name}
                  </Link>
                ) : undefined
              }
              editor={({ value, commit, autoFocus }) =>
                choices.length ? (
                  <Select value={value ?? ""} onChange={(e) => commit(e.target.value || null)} autoFocus={autoFocus} aria-label="Parent organization" className="[&_select]:h-8 pointer-coarse:[&_select]:h-10 [&_select]:text-[13.5px]">
                    <option value="">None</option>
                    {choices.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <p className="py-1.5 text-[12.5px] text-muted">No parent organizations yet. Open the organization that should be the parent and mark it as one.</p>
                )
              }
              onSave={(parentId) => save({ parentId })}
            />
          )}
          <LabelsField value={org.tags} onSave={saveLabels} />
          <InlineField<boolean>
            label="Is a parent"
            value={org.isParent}
            display={org.isParent ? "Yes, others can be part of it" : "No"}
            editor={({ value, commit }) => <Checkbox checked={value} onChange={(e) => commit(e.target.checked)} label="Other organizations can be part of it" autoFocus />}
            onSave={(isParent) => save({ isParent })}
          />
          <CustomFieldRows entity="organization" values={org.custom} onSave={(key, v) => save({ custom: { [key]: v } })} />
        </dl>
      </SideCard>
      {forChildren ? <ChildLabelsDialog parent={{ id: org.id, name: org.name }} labels={forChildren} count={childCount} onClose={() => setForChildren(null)} /> : null}
    </>
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
        <OwnerField value={client.ownerId} onSave={(ownerId) => save({ ownerId })} />
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
              <Select value={value ?? ""} onChange={(e) => commit((e.target.value || null) as ClientHealth | null)} autoFocus className="[&_select]:h-8 pointer-coarse:[&_select]:h-10">
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
          clamp={false}
          display={
            person ? (
              <span className="block min-w-0">
                <Link href={`/people/${person.id}`} className="line-clamp-3 underline-offset-2 [overflow-wrap:anywhere] hover:underline" onClick={(e) => e.stopPropagation()}>
                  {personName(person)}
                </Link>
                {person.title ? <span className="line-clamp-3 block text-[12px] break-words text-muted">{person.title}</span> : null}
                {person.email || person.phone ? (
                  <span className="flex flex-wrap gap-x-3 text-[12px]">
                    {person.email ? (
                      <a href={`mailto:${person.email}`} className="truncate text-muted hover:text-primary" onClick={(e) => e.stopPropagation()}>
                        {person.email}
                      </a>
                    ) : null}
                    {person.phone ? (
                      <a href={`tel:${person.phone.replace(/[^\d+]/g, "")}`} className="text-muted tabular-nums hover:text-primary" onClick={(e) => e.stopPropagation()}>
                        {person.phone}
                      </a>
                    ) : null}
                  </span>
                ) : null}
              </span>
            ) : undefined
          }
          editor={contactEditor}
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
          editor={organizationEditor}
          onSave={(v) => save({ organizationId: v && "record" in v ? v.record.id : null })}
        />
        <LabelsField value={client.tags} onSave={(tags) => save({ tags })} />
        <CustomFieldRows entity="client" values={client.custom} onSave={(key, v) => save({ custom: { [key]: v } })} />
      </dl>
    </SideCard>
  );
}

// ─── Related lists ───────────────────────────────────────────────────────

export type RelatedClient = { id: string; name: string; category: ClientCategory; value: number; mrr: number | string; stageName: string | null };

const categoryOrder: Record<ClientCategory, number> = { current: 0, prospective: 1, past: 2 };

/**
 * The clients a person or organization is part of. It's the first card on
 * their page, above the details, so which account they belong to is always in
 * view; with a client it's outlined in the accent color. Adding a client when
 * they already have one asks first.
 */
export function RelatedClients({ subject, clients, create }: { subject: string; clients: RelatedClient[]; create: Parameters<typeof openCreate>[0] }) {
  const { money } = useApp();
  const [confirming, setConfirming] = useState(false);
  const sorted = [...clients].sort((a, b) => categoryOrder[a.category] - categoryOrder[b.category]);
  return (
    <>
      <SideCard
        className={clients.length ? "border-accent" : undefined}
        title={
          <>
            {clients.length === 1 ? "Client" : "Clients"} <span className="font-medium text-muted tabular-nums">{clients.length > 1 ? clients.length : ""}</span>
          </>
        }
        action={
          <Button size="sm" variant="ghost" className="-mr-2" onClick={() => (clients.length ? setConfirming(true) : openCreate(create))}>
            <PlusIcon />
            Client
          </Button>
        }
      >
        {clients.length ? (
          <ul className="-mx-2">
            {sorted.map((d) => (
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
      {confirming ? (
        <AnotherClientDialog
          subject={subject}
          clients={sorted}
          onClose={() => setConfirming(false)}
          onContinue={() => {
            setConfirming(false);
            openCreate(create);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * Before a second client for the same person or organization: most need only
 * one, so it shows the ones they have and lets the user go ahead anyway.
 */
function AnotherClientDialog({ subject, clients, onClose, onContinue }: { subject: string; clients: RelatedClient[]; onClose: () => void; onContinue: () => void }) {
  const one = clients.length === 1;
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      size="sm"
      title={`${subject} is already connected to ${one ? "a client" : `${clients.length} clients`}`}
      description={`People and organizations usually need only one client. Open ${one ? "it" : "one of them"} below, or create another if this is a separate relationship.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onContinue}>
            Create another client
          </Button>
        </>
      }
    >
      <ul className="-mx-2">
        {clients.map((d) => (
          <li key={d.id}>
            <Link href={`/clients/${d.id}`} onClick={onClose} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sunken">
              <BriefcaseIcon className="size-4 shrink-0 text-faint" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-primary">{d.name}</span>
                <span className="block truncate text-[11.5px] text-muted">{d.stageName}</span>
              </span>
              <CategoryBadge category={d.category} />
            </Link>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

/** A parent organization's organizations, by name, with a way to add one and to see everyone across them. */
export function RelatedOrganizations({ parent, organizations }: { parent: { id: string; name: string }; organizations: { id: string; name: string; peopleCount: number }[] }) {
  const { canEdit } = useApp();
  return (
    <SideCard
      title={
        <>
          Organizations <span className="font-medium text-muted tabular-nums">{organizations.length || ""}</span>
        </>
      }
      action={
        canEdit ? (
          <Button size="sm" variant="ghost" className="-mr-2" onClick={() => openCreate({ kind: "organization", defaults: { parentId: parent.id } })}>
            <PlusIcon />
            Organization
          </Button>
        ) : undefined
      }
    >
      {organizations.length ? (
        <>
          <ul className="-mx-2 max-h-80 overflow-y-auto">
            {organizations.map((o) => (
              <li key={o.id}>
                <Link href={`/organizations/${o.id}`} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-sunken">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-sunken">
                    <BuildingOffice2Icon className="size-3.5 text-muted" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-primary">{o.name}</span>
                  <span className="shrink-0 text-[11.5px] text-muted tabular-nums">{o.peopleCount ? `${o.peopleCount} ${o.peopleCount === 1 ? "person" : "people"}` : ""}</span>
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-1 flex gap-1 text-[12px]">
            <Link href={`/people?parent=${parent.id}`} className="rounded-md px-2 py-1 text-muted hover:bg-sunken hover:text-primary">
              See all their people
            </Link>
            <Link href={`/organizations?parent=${parent.id}`} className="rounded-md px-2 py-1 text-muted hover:bg-sunken hover:text-primary">
              Open as a list
            </Link>
          </div>
        </>
      ) : (
        <p className="py-1 text-[12.5px] text-muted">None yet. Open an organization and pick {parent.name} as its parent organization.</p>
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
          {/* Decision makers first, A to Z: they're who the account is won or lost with. Then everyone else, A to Z. */}
          {orderPeople(people, (p) => ({ name: personName(p), starred: p.decisionMaker })).map((p) => (
            <li key={p.id} className="group flex items-center rounded-md hover:bg-sunken">
              <Link href={`/people/${p.id}`} className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-2">
                <Avatar name={personName(p)} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-primary">{personName(p)}</span>
                  <span className="block truncate text-[11.5px] text-muted">{p.title ?? p.email ?? ""}</span>
                </span>
              </Link>
              <StarToggle personId={p.id} starred={p.decisionMaker} name={p.firstName} className={clsx("mr-1", !p.decisionMaker && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="py-1 text-[12.5px] text-muted">No people yet.</p>
      )}
    </SideCard>
  );
}

export function OrganizationCard({ org, title = "Organization" }: { org: Organization; title?: string }) {
  return (
    <SideCard title={title}>
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

