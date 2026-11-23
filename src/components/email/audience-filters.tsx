"use client";

import clsx from "clsx";
import { useApp } from "@/components/app-context";
import { Segmented } from "@/components/activity/composer";
import { Tag } from "@/components/ui/badge";
import { Checkbox, Input } from "@/components/ui/field";
import type { CampaignAudience } from "@/db/schema";
import { appConfig } from "@/app.config";
import { churnReasons, clientCategories, clientCategoryLabels } from "@/lib/constants";

type ListKey = "tags" | "excludeTags" | "ownerIds" | "clientCategories" | "pipelineIds" | "stageIds" | "stripeProducts" | "churnReasons" | "clientTags" | "organizationIndustries" | "organizationIds";

/** Whether any filter is set, so the summary can say "everyone" or "people who match all of these". */
export function hasFilters(a: CampaignAudience) {
  return Object.entries(a).some(([k, v]) => k !== "tagMatch" && (Array.isArray(v) ? v.length : !!v));
}

/**
 * The filters an audience is made of. Within a group, any choice matches
 * (except tags set to "all"); across groups, people must match every group.
 * Client filters find people who are a matching client's contact or work at
 * its organization.
 */
export function AudienceFilters({
  audience,
  onChange,
  tags,
  clientTags,
  industries = [],
  readOnly,
}: {
  audience: CampaignAudience;
  onChange: (fn: (a: CampaignAudience) => CampaignAudience) => void;
  tags: string[];
  clientTags: string[];
  /** Organizations' industries, to filter by the company people work at. */
  industries?: string[];
  readOnly?: boolean;
}) {
  const { team, pipelines, stripeProducts, customFields, parentOrganizations, labels } = useApp();
  const toggle = (key: ListKey, value: string) =>
    onChange((a) => {
      const list = (a[key] ?? []) as string[];
      const next = list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
      return { ...a, [key]: next.length ? next : undefined };
    });
  const setDays = (key: "activeWithinDays" | "inactiveForDays" | "noCampaignForDays", raw: string) =>
    onChange((a) => {
      const n = Math.round(Number(raw));
      return { ...a, [key]: raw && n > 0 ? Math.min(n, 3650) : undefined };
    });
  // Hidden labels aren't offered; one already chosen stays so it can be taken off.
  const offered = (all: string[], chosen: string[] | undefined) => all.filter((t) => !labels.find((l) => l.name === t)?.hidden || chosen?.includes(t));
  const personLabels = offered(tags, [...(audience.tags ?? []), ...(audience.excludeTags ?? [])]);
  const clientLabels = offered(clientTags, audience.clientTags);
  const choosable = customFields.filter((f) => f.entityType === "person" && (f.type === "select" || f.type === "multiselect" || f.type === "checkbox"));
  const toggleField = (list: "customFields" | "organizationFields", key: string, value: string) =>
    onChange((a) => {
      const current = a[list] ?? [];
      const values = current.find((f) => f.key === key)?.values ?? [];
      const nextValues = values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
      const rest = current.filter((f) => f.key !== key);
      const next = nextValues.length ? [...rest, { key, values: nextValues }] : rest;
      return { ...a, [list]: next.length ? next : undefined };
    });
  const toggleCustom = (key: string, value: string) => toggleField("customFields", key, value);
  const orgChoosable = customFields.filter((f) => f.entityType === "organization" && (f.type === "select" || f.type === "multiselect" || f.type === "checkbox"));

  return (
    <div className={clsx("flex flex-col gap-3", readOnly && "pointer-events-none opacity-70")} aria-disabled={readOnly || undefined}>
      <div>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <p className="text-[12px] font-medium text-secondary">Labeled</p>
          {(audience.tags?.length ?? 0) > 1 ? (
            <Segmented
              value={audience.tagMatch ?? "any"}
              onChange={(v) => onChange((a) => ({ ...a, tagMatch: v === "all" ? "all" : undefined }))}
              options={[
                { value: "any", label: "Any of these" },
                { value: "all", label: "All of these" },
              ]}
            />
          ) : null}
        </div>
        <Chips options={personLabels.map((t) => ({ value: t, label: t }))} selected={audience.tags ?? []} onToggle={(v) => toggle("tags", v)} empty="No labels on people or organizations yet. Add them from a record's page or during import." />
        {personLabels.length ? <p className="mt-1.5 text-fine">A person has a label when they or their organization has it.</p> : null}
      </div>
      {personLabels.length ? <ChipGroup label="Not labeled" options={personLabels.map((t) => ({ value: t, label: t }))} selected={audience.excludeTags ?? []} onToggle={(v) => toggle("excludeTags", v)} /> : null}
      <ChipGroup label="Owned by" options={team.filter((m) => m.active).map((m) => ({ value: m.id, label: m.name }))} selected={audience.ownerIds ?? []} onToggle={(v) => toggle("ownerIds", v)} />
      <div className="grid gap-3 sm:grid-cols-3">
        <DaysField label="Contacted in the last" value={audience.activeWithinDays} onChange={(v) => setDays("activeWithinDays", v)} />
        <DaysField label="Not contacted in the last" value={audience.inactiveForDays} onChange={(v) => setDays("inactiveForDays", v)} />
        <DaysField label="No campaign in the last" value={audience.noCampaignForDays} onChange={(v) => setDays("noCampaignForDays", v)} />
      </div>
      <p className="-mt-1 text-fine">Contact means something logged or a one-off email. Campaigns only count toward the campaign filter.</p>
      {choosable.map((f) => (
        <ChipGroup
          key={f.id}
          label={f.label}
          options={f.type === "checkbox" ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] : f.options.map((o) => ({ value: o, label: o }))}
          selected={audience.customFields?.find((c) => c.key === f.key)?.values ?? []}
          onToggle={(v) => toggleCustom(f.key, v)}
        />
      ))}
      <div className="flex flex-col gap-3 border-t border-line pt-3">
        <Checkbox
          checked={!!audience.decisionMakersOnly}
          onChange={(e) => onChange((a) => ({ ...a, decisionMakersOnly: e.target.checked || undefined }))}
          label={<span className="text-[13px]">Only {appConfig.records.keyContactLabel.toLowerCase()}s (people starred at their organization)</span>}
        />
        {parentOrganizations.length || audience.organizationIds?.length ? (
          <div>
            <ChipGroup
              label="Part of"
              options={[
                ...parentOrganizations.map((o) => ({ value: o.id, label: o.name })),
                // Chosen before, and since archived or unmarked as a parent: still shown so it can be taken off.
                ...(audience.organizationIds ?? []).filter((id) => !parentOrganizations.some((o) => o.id === id)).map((id) => ({ value: id, label: "Another organization" })),
              ]}
              selected={audience.organizationIds ?? []}
              onToggle={(v) => toggle("organizationIds", v)}
            />
            <p className="mt-1.5 text-fine">People at the parent organization and at every organization that is part of it.</p>
          </div>
        ) : null}
        {industries.length || audience.organizationIndustries?.length ? (
          <ChipGroup
            label="At organizations in"
            options={[...new Set([...industries, ...(audience.organizationIndustries ?? [])])].map((i) => ({ value: i, label: i }))}
            selected={audience.organizationIndustries ?? []}
            onToggle={(v) => toggle("organizationIndustries", v)}
          />
        ) : null}
        {orgChoosable.map((f) => (
          <ChipGroup
            key={f.id}
            label={`Organization: ${f.label}`}
            options={f.type === "checkbox" ? [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] : f.options.map((o) => ({ value: o, label: o }))}
            selected={audience.organizationFields?.find((c) => c.key === f.key)?.values ?? []}
            onToggle={(v) => toggleField("organizationFields", f.key, v)}
          />
        ))}
      </div>
      <ClientFilters audience={audience} onChange={onChange} toggle={toggle} pipelines={pipelines} stripeProducts={stripeProducts} clientTags={clientLabels} />
    </div>
  );
}

function DaysField({ label, value, onChange }: { label: string; value: number | undefined; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-secondary">{label}</span>
      <span className="flex items-center gap-2 text-[13px] text-muted">
        <Input type="number" min={1} max={3650} inputMode="numeric" value={value ?? ""} onChange={(e) => onChange(e.target.value)} placeholder="Any" className="h-8 w-20 text-[13px]" />
        days
      </span>
    </label>
  );
}

/** Client filters. Stages narrow to the chosen categories and pipelines; churn reasons only make sense for past clients. */
function ClientFilters({
  audience,
  onChange,
  toggle,
  pipelines,
  stripeProducts,
  clientTags,
}: {
  audience: CampaignAudience;
  onChange: (fn: (a: CampaignAudience) => CampaignAudience) => void;
  toggle: (key: ListKey, value: string) => void;
  pipelines: ReturnType<typeof useApp>["pipelines"];
  stripeProducts: string[];
  clientTags: string[];
}) {
  const categories = audience.clientCategories ?? [];
  const inCategory = pipelines.filter((p) => !categories.length || categories.includes(p.category));
  const chosen = audience.pipelineIds ?? [];
  const shownPipelines = inCategory.filter((p) => !chosen.length || chosen.includes(p.id));
  const multi = shownPipelines.length > 1;
  // A product chosen earlier stays offered, so it can be taken off after nobody's on it any more.
  const products = [...new Set([...stripeProducts, ...(audience.stripeProducts ?? [])])];
  const showPast = !categories.length || categories.includes("past");
  const reasons = [...new Set([...churnReasons, ...(audience.churnReasons ?? [])])];
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-3">
      <ChipGroup label="Clients who are" options={clientCategories.map((c) => ({ value: c, label: clientCategoryLabels[c].one }))} selected={categories} onToggle={(v) => toggle("clientCategories", v)} />
      {inCategory.length > 1 || chosen.length ? <ChipGroup label="In pipeline" options={inCategory.map((p) => ({ value: p.id, label: p.name }))} selected={chosen} onToggle={(v) => toggle("pipelineIds", v)} /> : null}
      <ChipGroup
        label="In stage"
        options={shownPipelines.flatMap((p) => p.stages.map((s) => ({ value: s.id, label: multi ? `${p.name}: ${s.name}` : s.name })))}
        selected={audience.stageIds ?? []}
        onToggle={(v) => toggle("stageIds", v)}
      />
      <ChipGroup label="Subscribed to" options={products.map((p) => ({ value: p, label: p }))} selected={audience.stripeProducts ?? []} onToggle={(v) => toggle("stripeProducts", v)} empty="No clients are subscribed to anything in Stripe yet." />
      {audience.serviceIds?.length ? (
        <p className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
          Also filters by {audience.serviceIds.length === 1 ? "a service" : `${audience.serviceIds.length} services`} tracked by hand, from before services came from Stripe.
          <button type="button" className="font-medium text-primary underline-offset-2 hover:underline disabled:opacity-50" onClick={() => onChange((a) => ({ ...a, serviceIds: undefined }))}>
            Take it off
          </button>
        </p>
      ) : null}
      <ChipGroup label="Client labeled" options={clientTags.map((t) => ({ value: t, label: t }))} selected={audience.clientTags ?? []} onToggle={(v) => toggle("clientTags", v)} empty="No labels on clients yet. Add them from a client's page." />
      {showPast ? (
        <>
          <ChipGroup label="Left because" options={reasons.map((r) => ({ value: r, label: r }))} selected={audience.churnReasons ?? []} onToggle={(v) => toggle("churnReasons", v)} />
          <Checkbox
            checked={!!audience.openToReturnOnly}
            onChange={(e) => onChange((a) => ({ ...a, openToReturnOnly: e.target.checked || undefined }))}
            label={<span className="text-[13px]">Only past clients open to coming back</span>}
          />
        </>
      ) : null}
    </div>
  );
}

function ChipGroup({ label, ...props }: { label: string } & Parameters<typeof Chips>[0]) {
  return (
    <div>
      <p className="mb-1.5 text-[12px] font-medium text-secondary">{label}</p>
      <Chips {...props} />
    </div>
  );
}

function Chips({ options, selected, onToggle, empty }: { options: { value: string; label: string }[]; selected: string[]; onToggle: (v: string) => void; empty?: string }) {
  if (!options.length) return <p className="text-[12px] text-faint">{empty ?? "Nothing to choose yet."}</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = selected.includes(o.value);
        return (
          <button key={o.value} type="button" aria-pressed={on} onClick={() => onToggle(o.value)} className="rounded-full">
            <Tag className={on ? "border-accent bg-accent text-accent-foreground" : "hover:border-line-strong"}>{o.label}</Tag>
          </button>
        );
      })}
    </div>
  );
}
