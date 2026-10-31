"use client";

import { useState, useTransition } from "react";
import { PlusIcon } from "@heroicons/react/20/solid";
import { archiveCustomField, saveCustomField } from "@/actions/settings";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { customFieldTypeLabels, customFieldTypes, entityLabels, entityTypes, type CustomFieldType, type EntityType } from "@/lib/constants";
import type { CustomField } from "@/lib/crm/context";
import { Section } from "./nav";

export function FieldSettings({ fields }: { fields: CustomField[] }) {
  const [editing, setEditing] = useState<{ entity: EntityType; field: CustomField | null } | null>(null);
  return (
    <>
      {entityTypes.map((entity) => {
        const list = fields.filter((f) => f.entityType === entity);
        const active = list.filter((f) => !f.archivedAt);
        const archived = list.filter((f) => f.archivedAt);
        return (
          <Section
            key={entity}
            title={`${entityLabels[entity].one} fields`}
            description={`Extra details to keep on every ${entityLabels[entity].one.toLowerCase()}. They show in the Details panel and the add form.`}
            action={
              <Button size="sm" variant="outline" onClick={() => setEditing({ entity, field: null })}>
                <PlusIcon />
                Add field
              </Button>
            }
          >
            {active.length ? (
              <ul className="divide-y divide-line">
                {active.map((f) => (
                  <li key={f.id} className="flex items-center gap-3 px-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] font-medium text-primary">{f.label}</p>
                      <p className="text-[12px] text-muted">
                        {customFieldTypeLabels[f.type]}
                        {f.options.length ? ` · ${f.options.length} options` : ""}
                        {f.showInTable ? " · Shown in table" : ""}
                      </p>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => setEditing({ entity, field: f })}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        const r = await archiveCustomField(f.id, true);
                        if (!r.ok) return void toast.error(r.error);
                        toast.success(`${f.label} archived`, { label: "Undo", onClick: () => archiveCustomField(f.id, false) });
                      }}
                    >
                      Archive
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-4 text-[13px] text-muted">No custom fields yet.</p>
            )}
            {archived.length ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5 text-[12.5px] text-muted">
                Archived:
                {archived.map((f) => (
                  <button key={f.id} type="button" onClick={() => archiveCustomField(f.id, false)} title="Restore">
                    <Tag className="hover:border-line-strong">{f.label} · restore</Tag>
                  </button>
                ))}
              </div>
            ) : null}
          </Section>
        );
      })}
      {editing ? <FieldDialog entity={editing.entity} field={editing.field} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function FieldDialog({ entity, field, onClose }: { entity: EntityType; field: CustomField | null; onClose: () => void }) {
  const [label, setLabel] = useState(field?.label ?? "");
  const [type, setType] = useState<CustomFieldType>(field?.type ?? "text");
  const [options, setOptions] = useState(field?.options.join("\n") ?? "");
  const [showInTable, setShowInTable] = useState(field?.showInTable ?? false);
  const [pending, start] = useTransition();
  const hasOptions = type === "select" || type === "multiselect";
  const save = () =>
    start(async () => {
      const r = await saveCustomField(field?.id ?? null, {
        entityType: entity,
        label,
        type,
        options: hasOptions ? options.split("\n").map((o) => o.trim()).filter(Boolean) : [],
        showInTable,
      });
      if (!r.ok) return void toast.error(r.error);
      toast.success(field ? "Field saved" : `${label} added`);
      onClose();
    });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={field ? `Edit ${field.label}` : `New ${entityLabels[entity].one.toLowerCase()} field`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={save}>
            Save field
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label="Name">{(p) => <Input {...p} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Contract renewal date" />}</Field>
        <Field label="Type" hint={field ? "The type can't change once a field has values." : undefined}>
          {(p) => (
            <Select id={p.id} value={type} onChange={(e) => setType(e.target.value as CustomFieldType)} disabled={!!field}>
              {customFieldTypes.map((t) => (
                <option key={t} value={t}>
                  {customFieldTypeLabels[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {hasOptions ? (
          <Field label="Options" hint="One per line. Renaming an option doesn't change records that already use it.">
            {(p) => <Textarea {...p} value={options} onChange={(e) => setOptions(e.target.value)} rows={5} />}
          </Field>
        ) : null}
        <Checkbox checked={showInTable} onChange={(e) => setShowInTable(e.target.checked)} label={`Show as a column in the ${entityLabels[entity].many.toLowerCase()} table`} />
      </div>
    </Dialog>
  );
}
