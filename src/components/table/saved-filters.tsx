"use client";

import clsx from "clsx";
import { useEffect, useMemo, useState, useTransition } from "react";
import { CheckIcon, ChevronDownIcon, DocumentDuplicateIcon, EyeIcon, FunnelIcon, GlobeAltIcon, PencilIcon, PlusIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { deleteFilter, previewFilter, saveFilter } from "@/actions/saved-filters";
import { useApp } from "@/components/app-context";
import { useLabels } from "@/components/records/labels";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { clientCategoryLabels, type EntityType } from "@/lib/constants";
import { conditionProblem, fieldGroups, findField, kindOperators, operatorLabels, valueShape, type FieldMeta, type FilterCondition, type OptionSource } from "@/lib/crm/filter-fields";
import type { SavedFilter } from "@/lib/crm/saved-filters";
import { useListParams } from "./use-params";

/** What a list page hands its Filters menu: the filters the viewer can pick, the one in the URL, and whether that one couldn't be found. */
export type SavedFiltersState = { filters: SavedFilter[]; active: SavedFilter | null; missing: boolean };

const nouns: Record<EntityType, [string, string]> = { person: ["person", "people"], organization: ["organization", "organizations"], client: ["client", "clients"] };

/**
 * The Filters menu on the People, Organizations and Clients lists: the
 * viewer's own filters, then the ones teammates shared, and a way to make a
 * new one. The filter in use is in the URL (`?filter=`), so a filtered view
 * can be linked and survives reloads.
 */
export function SavedFilterMenu({ entity, state }: { entity: EntityType; state: SavedFiltersState }) {
  const { viewer, isAdmin, canEdit } = useApp();
  const { set } = useListParams();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<{ filter: SavedFilter | null } | null>(null);
  const { filters, active, missing } = state;
  const term = q.trim().toLowerCase();
  const matches = (f: SavedFilter) => !term || f.name.toLowerCase().includes(term);
  const mine = filters.filter((f) => f.createdBy === viewer.id && matches(f));
  const shared = filters.filter((f) => f.createdBy !== viewer.id && matches(f));
  const canManage = (f: SavedFilter) => canEdit && (f.createdBy === viewer.id || (isAdmin && f.shared));

  const pick = (f: SavedFilter) => {
    setOpen(false);
    set({ filter: active?.id === f.id ? null : f.id });
  };
  const edit = (f: SavedFilter | null) => {
    setOpen(false);
    setEditing({ filter: f });
  };

  const row = (f: SavedFilter) => (
    <li key={f.id} className="group flex items-center gap-1">
      <button
        type="button"
        onClick={() => pick(f)}
        aria-pressed={active?.id === f.id}
        className="flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] text-secondary hover:bg-sunken hover:text-primary pointer-coarse:min-h-11"
      >
        <CheckIcon className={clsx("size-4 shrink-0", active?.id === f.id ? "text-primary" : "invisible")} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{f.name}</span>
          {f.createdBy !== viewer.id ? <span className="block truncate text-[11.5px] text-muted">by {f.createdByName ?? "a former teammate"}</span> : null}
        </span>
        {f.shared && f.createdBy === viewer.id ? <GlobeAltIcon className="size-3.5 shrink-0 text-faint" aria-label="Shared with the team" /> : null}
      </button>
      <button
        type="button"
        onClick={() => edit(f)}
        className="rounded-md p-1.5 text-faint hover:bg-sunken hover:text-primary focus-visible:opacity-100 pointer-coarse:p-2.5 sm:opacity-0 sm:group-hover:opacity-100"
        aria-label={canManage(f) ? `Edit ${f.name}` : `See the conditions of ${f.name}`}
      >
        {canManage(f) ? <PencilIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
      </button>
    </li>
  );

  return (
    <>
      <div className="flex items-center">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={clsx(
                "flex h-8 max-w-60 items-center gap-1.5 border px-2.5 text-[13px] shadow-sm pointer-coarse:h-10",
                active || missing ? "rounded-l-md border-accent bg-accent-soft text-accent-soft-foreground" : "rounded-md border-line bg-surface text-primary hover:bg-sunken",
              )}
            >
              <FunnelIcon className="size-4 shrink-0 text-muted" aria-hidden />
              <span className="truncate">{active ? active.name : missing ? "Filter not found" : "Filters"}</span>
              <ChevronDownIcon className="size-4 shrink-0 text-muted" aria-hidden />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-1.5">
            {filters.length > 6 ? (
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Find a filter"
                aria-label="Find a filter"
                className="mb-1 h-8 w-full rounded-md border border-line bg-surface px-2.5 text-[13px] text-primary placeholder:text-faint focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none pointer-coarse:h-10 pointer-coarse:text-[16px]"
              />
            ) : null}
            <div className="max-h-80 overflow-y-auto">
              {!filters.length ? (
                <p className="px-2 py-2 text-[12.5px] text-muted">
                  No saved filters yet. A filter can combine conditions on {nouns[entity][1]} and the records tied to them, like their organization&apos;s time zone.
                </p>
              ) : !mine.length && !shared.length ? (
                <p className="px-2 py-2 text-[12.5px] text-muted">No filter has that name.</p>
              ) : null}
              {mine.length ? (
                <>
                  <p className="px-2 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">My filters</p>
                  <ul>{mine.map(row)}</ul>
                </>
              ) : null}
              {shared.length ? (
                <>
                  <p className="px-2 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-faint uppercase">Shared with the team</p>
                  <ul>{shared.map(row)}</ul>
                </>
              ) : null}
            </div>
            {canEdit ? (
              <div className="mt-1 border-t border-line pt-1">
                <button type="button" onClick={() => edit(null)} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] text-secondary hover:bg-sunken hover:text-primary pointer-coarse:h-11">
                  <PlusIcon className="size-4" aria-hidden />
                  New filter
                </button>
              </div>
            ) : null}
          </PopoverContent>
        </Popover>
        {active || missing ? (
          <button
            type="button"
            onClick={() => set({ filter: null })}
            className="flex h-8 items-center rounded-r-md border border-l-0 border-accent bg-accent-soft px-1.5 text-muted hover:text-primary pointer-coarse:h-10 pointer-coarse:px-2.5"
            aria-label="Stop filtering"
          >
            <XMarkIcon className="size-4" />
          </button>
        ) : null}
      </div>
      {editing ? <FilterDialog key={editing.filter?.id ?? "new"} entity={entity} filter={editing.filter} canManage={editing.filter ? canManage(editing.filter) : true} activeId={active?.id ?? null} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

// ─── The builder ─────────────────────────────────────────────────────────

type Option = { value: string; label: string; group?: string };

/** The choices for a field, from what the app already loaded. */
function useOptions() {
  const { team, pipelines, parentOrganizations, stripeProducts } = useApp();
  const labels = useLabels();
  return (source: OptionSource | undefined): Option[] => {
    if (!source) return [];
    if (Array.isArray(source)) return source;
    switch (source) {
      case "team":
        return team.map((m) => ({ value: m.id, label: m.active ? m.name : `${m.name} (inactive)` }));
      case "pipelines":
        return pipelines.map((p) => ({ value: p.id, label: p.name, group: clientCategoryLabels[p.category].many }));
      case "stages":
        return pipelines.flatMap((p) => p.stages.map((s) => ({ value: s.id, label: s.name, group: p.name })));
      case "parents":
        return parentOrganizations.map((p) => ({ value: p.id, label: p.name }));
      case "stripeProducts":
        return stripeProducts.map((p) => ({ value: p, label: p }));
      default:
        return labels.all.filter((l) => !l.hidden).map((l) => ({ value: l.name, label: l.name }));
    }
  };
}

const blank = (field: FieldMeta): FilterCondition => ({ field: field.key, op: kindOperators[field.kind][0] });

function FilterDialog({ entity, filter, canManage, activeId, onClose }: { entity: EntityType; filter: SavedFilter | null; canManage: boolean; activeId: string | null; onClose: () => void }) {
  const { customFields, canEdit } = useApp();
  const { set } = useListParams();
  const groups = useMemo(() => fieldGroups(entity, customFields), [entity, customFields]);
  const first = groups[0].fields[0];
  // Someone else's shared filter opens to look at, and to save a copy of.
  const copying = !!filter && !canManage;
  const [name, setName] = useState(filter ? (copying ? `${filter.name} (copy)` : filter.name) : "");
  const [all, setAll] = useState<FilterCondition[]>(filter?.conditions.all ?? [blank(first)]);
  const [any, setAny] = useState<FilterCondition[]>(filter?.conditions.any ?? []);
  const [shared, setShared] = useState(copying ? false : (filter?.shared ?? false));
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, start] = useTransition();
  const [count, setCount] = useState<number | null>(null);
  const [noun, nounMany] = nouns[entity];

  // How many match, as the conditions change.
  const key = JSON.stringify({ all, any });
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      const r = await previewFilter(entity, JSON.parse(key));
      if (live && r.ok) setCount(r.data.count);
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [entity, key]);

  const save = (asNew: boolean) =>
    start(async () => {
      setError(null);
      const problem = [...all, ...any].map((c) => conditionProblem(c, customFields)).find(Boolean);
      if (!all.length && !any.length) return setError("Add at least one condition.");
      if (problem) return setError(problem);
      const r = await saveFilter(asNew ? null : filter!.id, { name, entityType: entity, conditions: { all, any }, shared });
      if (!r.ok) return setError(r.error);
      onClose();
      set({ filter: r.data.id });
      toast.success(asNew || !filter ? `Filter “${name.trim()}” saved${shared ? " and shared with the team" : ""}` : `Filter “${name.trim()}” updated`);
    });

  const remove = () =>
    start(async () => {
      const r = await deleteFilter(filter!.id);
      if (!r.ok) return setError(r.error);
      onClose();
      if (activeId === filter!.id) set({ filter: null });
      toast.success(`Filter “${filter!.name}” deleted`);
    });

  const readOnly = copying && !canEdit;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={!filter ? "New filter" : copying ? filter.name : "Edit filter"}
      description={copying ? `Shared by ${filter.createdByName ?? "a former teammate"}. Only they or an admin can change it${canEdit ? "; save a copy to make your own." : "."}` : undefined}
      size="xl"
      footer={
        <>
          <p className="mr-auto text-[12.5px] text-muted tabular-nums" aria-live="polite">
            {count === null ? " " : `${count.toLocaleString()} ${count === 1 ? noun : nounMany} match`}
          </p>
          {filter && canManage ? (
            confirmDelete ? (
              <Button variant="destructive" onClick={remove} loading={pending}>
                Delete for {filter.shared ? "everyone" : "good"}
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            )
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            {readOnly ? "Close" : "Cancel"}
          </Button>
          {filter && canManage ? (
            <Button variant="outline" onClick={() => save(true)} disabled={pending}>
              <DocumentDuplicateIcon aria-hidden />
              Save as new
            </Button>
          ) : null}
          {readOnly ? null : (
            <Button variant="primary" type="submit" form="saved-filter" loading={pending}>
              {copying ? "Save a copy" : "Save filter"}
            </Button>
          )}
        </>
      }
    >
      <form
        id="saved-filter"
        onSubmit={(e) => {
          e.preventDefault();
          save(!filter || copying);
        }}
        className="flex flex-col gap-5"
      >
        {error ? (
          <p role="alert" className="rounded-md border border-error-border bg-error-surface px-3 py-2 text-[13px] text-error">
            {error}
          </p>
        ) : null}
        <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder={`Eastern time zone ${nounMany}`} disabled={readOnly} autoComplete="off" />}</Field>
        <ConditionGroup title={`Show ${nounMany} that match all of these`} groups={groups} conditions={all} onChange={setAll} fallback={first} readOnly={readOnly} />
        <ConditionGroup title="And at least one of these" hint="Leave empty to skip." groups={groups} conditions={any} onChange={setAny} fallback={first} readOnly={readOnly} />
        {readOnly ? null : (
          <div className="border-t border-line pt-4">
            <Checkbox checked={shared} onChange={(e) => setShared(e.target.checked)} label="Share with the team" />
            <p className="mt-1 ml-6 text-fine">Everyone sees it in their Filters menu. Only you and admins can change it.</p>
          </div>
        )}
      </form>
    </Dialog>
  );
}

function ConditionGroup({
  title,
  hint,
  groups,
  conditions,
  onChange,
  fallback,
  readOnly,
}: {
  title: string;
  hint?: string;
  groups: ReturnType<typeof fieldGroups>;
  conditions: FilterCondition[];
  onChange: (c: FilterCondition[]) => void;
  fallback: FieldMeta;
  readOnly: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-label">
        {title}
        {hint ? <span className="ml-1.5 font-normal text-muted">{hint}</span> : null}
      </legend>
      {conditions.map((c, i) => (
        <ConditionRow
          key={i}
          condition={c}
          groups={groups}
          readOnly={readOnly}
          onChange={(next) => onChange(conditions.map((x, j) => (j === i ? next : x)))}
          onRemove={() => onChange(conditions.filter((_, j) => j !== i))}
        />
      ))}
      {readOnly ? null : (
        <div>
          <Button size="sm" variant="ghost" className="-ml-2" onClick={() => onChange([...conditions, blank(fallback)])} disabled={conditions.length >= 20}>
            <PlusIcon aria-hidden />
            Add condition
          </Button>
        </div>
      )}
    </fieldset>
  );
}

const control = "[&_select]:h-8 pointer-coarse:[&_select]:h-10 [&_select]:text-[13px]";

function ConditionRow({ condition: c, groups, onChange, onRemove, readOnly }: { condition: FilterCondition; groups: ReturnType<typeof fieldGroups>; onChange: (c: FilterCondition) => void; onRemove: () => void; readOnly: boolean }) {
  const { customFields } = useApp();
  const field = findField(c.field, customFields);
  const ops = field ? kindOperators[field.kind] : [];
  const group = groups.find((g) => g.entity === field?.entity);
  return (
    <div className="grid grid-cols-[1fr_auto] items-start gap-2 rounded-lg border border-line bg-canvas p-2 sm:grid-cols-[minmax(0,14rem)_minmax(0,10rem)_minmax(0,1fr)_auto] sm:border-0 sm:bg-transparent sm:p-0">
      <Select
        value={c.field}
        onChange={(e) => {
          const next = findField(e.target.value, customFields);
          if (next) onChange({ field: next.key, op: kindOperators[next.kind][0] });
        }}
        aria-label="Field"
        className={clsx(control, "max-sm:col-span-1")}
        disabled={readOnly}
      >
        {field ? null : <option value={c.field}>A field that no longer exists</option>}
        {groups.map((g) => (
          <optgroup key={g.entity} label={g.label}>
            {g.fields.map((f) => (
              <option key={f.key} value={f.key}>
                {g === groups[0] ? f.label : `${g.label}: ${f.label}`}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
      <Button size="icon-sm" variant="ghost" onClick={onRemove} aria-label={`Remove the condition on ${field?.label ?? "this field"}`} className="sm:order-last" disabled={readOnly}>
        <XMarkIcon />
      </Button>
      <Select
        value={c.op}
        onChange={(e) => {
          const op = e.target.value as FilterCondition["op"];
          onChange({ field: c.field, op, ...(valueShape(op) === valueShape(c.op) ? { value: c.value } : {}) });
        }}
        aria-label={`How ${field?.label ?? "the field"} compares${group && group !== groups[0] ? ` (${group.label})` : ""}`}
        className={control}
        disabled={readOnly || !field}
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {operatorLabels[op]}
          </option>
        ))}
      </Select>
      <div className="max-sm:col-span-2">{field ? <ValueInput field={field} condition={c} onChange={(value) => onChange({ ...c, value })} readOnly={readOnly} /> : null}</div>
    </div>
  );
}

const inputClass = "h-8 text-[13px] pointer-coarse:h-10";

function ValueInput({ field, condition: c, onChange, readOnly }: { field: FieldMeta; condition: FilterCondition; onChange: (v: FilterCondition["value"]) => void; readOnly: boolean }) {
  const options = useOptions()(field.options);
  const shape = valueShape(c.op);
  if (shape === "none") return null;
  if (shape === "list") return <OptionPicker options={options} value={Array.isArray(c.value) ? c.value : []} onChange={onChange} label={field.label} disabled={readOnly} />;
  if (shape === "date") return <Input type="date" value={typeof c.value === "string" ? c.value : ""} onChange={(e) => onChange(e.target.value || undefined)} aria-label={`Value for ${field.label}`} className={inputClass} disabled={readOnly} />;
  if (shape === "days")
    return (
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={1}
          step={1}
          value={typeof c.value === "number" ? c.value : ""}
          onChange={(e) => onChange(e.target.value ? Math.max(1, Math.round(Number(e.target.value))) : undefined)}
          aria-label={`Days for ${field.label}`}
          className={clsx(inputClass, "w-24")}
          disabled={readOnly}
        />
        <span className="text-[13px] text-muted">days</span>
      </div>
    );
  if (shape === "number") {
    // Money is typed in whole units and kept in cents, like everywhere else.
    const money = field.kind === "money";
    return (
      <Input
        type="number"
        step="any"
        value={typeof c.value === "number" ? (money ? c.value / 100 : c.value) : ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : money ? Math.round(Number(e.target.value) * 100) : Number(e.target.value))}
        aria-label={`Value for ${field.label}`}
        placeholder={money ? "0.00" : "0"}
        className={inputClass}
        disabled={readOnly}
      />
    );
  }
  return <Input value={typeof c.value === "string" ? c.value : ""} onChange={(e) => onChange(e.target.value)} aria-label={`Value for ${field.label}`} className={inputClass} disabled={readOnly} autoComplete="off" />;
}

/** Picks one or more of a field's values, with a search when there are many. */
function OptionPicker({ options, value, onChange, label, disabled }: { options: Option[]; value: string[]; onChange: (v: string[]) => void; label: string; disabled: boolean }) {
  const [q, setQ] = useState("");
  const chosen = new Set(value);
  const term = q.trim().toLowerCase();
  const shown = options.filter((o) => !term || o.label.toLowerCase().includes(term) || o.group?.toLowerCase().includes(term));
  const names = value.map((v) => options.find((o) => o.value === v)?.label ?? v);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="flex h-8 w-full items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-left text-[13px] shadow-sm hover:border-line-strong disabled:opacity-60 pointer-coarse:h-10"
          aria-label={`Values for ${label}`}
        >
          <span className={clsx("min-w-0 flex-1 truncate", names.length ? "text-primary" : "text-faint")}>{names.length ? names.join(", ") : "Pick values"}</span>
          <ChevronDownIcon className="size-4 shrink-0 text-muted" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1.5">
        {options.length > 8 ? (
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search"
            aria-label={`Search ${label}`}
            className="mb-1 h-8 w-full rounded-md border border-line bg-surface px-2.5 text-[13px] text-primary placeholder:text-faint focus:border-ring focus:ring-1 focus:ring-ring focus:outline-none pointer-coarse:text-[16px]"
          />
        ) : null}
        <ul className="max-h-64 overflow-y-auto">
          {!shown.length ? <li className="px-2 py-1.5 text-[12.5px] text-muted">{options.length ? "No matches" : "Nothing to pick yet."}</li> : null}
          {shown.map((o, i) => (
            <li key={o.value}>
              {o.group && o.group !== shown[i - 1]?.group ? <p className="px-2 pt-1.5 pb-0.5 text-[11px] font-semibold tracking-wide text-faint uppercase">{o.group}</p> : null}
              <label className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] text-secondary hover:bg-sunken hover:text-primary pointer-coarse:min-h-11">
                <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={chosen.has(o.value)} onChange={() => onChange(chosen.has(o.value) ? value.filter((v) => v !== o.value) : [...value, o.value])} />
                <span className="truncate">{o.label}</span>
              </label>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
