"use client";

import { PlusIcon } from "@heroicons/react/20/solid";
import { BuildingOffice2Icon } from "@heroicons/react/24/outline";
import { useCallback, useState } from "react";
import { assignOwner, moreOrganizations, setArchived } from "@/actions/records";
import { useApp } from "@/components/app-context";
import { CategoryBadge } from "@/components/clients/client-controls";
import { BulkButton } from "@/components/clients/clients-view";
import { formatCustomValue } from "@/components/records/custom-field-input";
import { PageHeader } from "@/components/shell/app-shell";
import { openCreate } from "@/components/shell/create-store";
import { AgoCell, NextActivityCell, OwnerCell } from "@/components/table/cells";
import { DataTable, type Column } from "@/components/table/data-table";
import { OwnerFilter, ParentFilter, SearchBox, Toolbar } from "@/components/table/toolbar";
import { usePagedRows } from "@/components/table/use-paged-rows";
import { MergeDialog, type MergeCandidate } from "@/components/records/merge-dialog";
import { Button } from "@/components/ui/button";
import { LabelChips, useLabels } from "@/components/records/labels";
import { useListParams } from "@/components/table/use-params";
import { Tag } from "@/components/ui/badge";
import { Select } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toast";
import type { listOrganizations, OrgFilter } from "@/lib/crm/records";

type Row = Awaited<ReturnType<typeof listOrganizations>>[number];

const rowId = (r: Row) => r.organization.id;

export function OrganizationsView({ rows: first, total, filter, pageSize, filtered }: { rows: Row[]; total: number; filter: OrgFilter; pageSize: number; filtered: boolean }) {
  const { viewer, customFields, money, team, member, canEdit, parentOrganizations } = useApp();
  const labels = useLabels();
  const listParams = useListParams();
  const pickable = labels.all.filter((l) => !l.hidden);
  const [merging, setMerging] = useState<{ rows: Row[]; done: () => void } | null>(null);
  const filterKey = JSON.stringify(filter);
  const fetchPage = useCallback((offset: number, limit: number) => moreOrganizations(JSON.parse(filterKey), { offset, limit }), [filterKey]);
  const paging = usePagedRows({ first, total, filterKey, rowId, pageSize, fetchPage });
  const rows = paging.rows;

  const candidate = (r: Row): MergeCandidate => ({
    id: r.organization.id,
    title: r.organization.name,
    subtitle: r.organization.domain,
    createdAt: r.organization.createdAt,
    lastActivityAt: r.organization.lastActivityAt,
    fields: [
      { label: "Name", value: r.organization.name },
      { label: "Website", value: r.organization.domain },
      { label: "Phone", value: r.organization.phone },
      { label: "Address", value: r.organization.address },
      { label: "Industry", value: r.organization.industry },
      { label: "Parent organization", value: r.organization.isParent ? "Is a parent organization" : r.parentName },
      { label: "Owner", value: r.organization.ownerId ? (member(r.organization.ownerId)?.name ?? "A former teammate") : null },
      ...customFields.filter((f) => f.entityType === "organization").map((f) => ({ label: f.label, value: formatCustomValue(f, r.organization.custom[f.key], money) || null })),
    ],
    extras: [r.peopleCount ? `${r.peopleCount} ${r.peopleCount === 1 ? "person" : "people"}` : null, r.clientCategories.length ? `${r.clientCategories.length === 1 ? "Client" : "Clients"}: ${r.clientCategories.join(", ")}` : null].filter((x): x is string => !!x),
  });
  const columns: Column<Row>[] = [
    {
      key: "name",
      label: "Name",
      sort: "name",
      className: "min-w-52",
      render: (r) => (
        <span className="flex items-center gap-2.5">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-sunken">
            <BuildingOffice2Icon className="size-3.5 text-muted" />
          </span>
          <span className="truncate font-medium text-primary">{r.organization.name}</span>
          {r.organization.isParent ? <Tag className="shrink-0">Parent</Tag> : null}
        </span>
      ),
    },
    ...(parentOrganizations.length ? [{ key: "parent", label: "Parent organization", render: (r) => r.parentName ?? <span className="text-faint">—</span> } satisfies Column<Row>] : []),
    {
      key: "domain",
      label: "Website",
      render: (r) =>
        r.organization.domain ? (
          <a href={`https://${r.organization.domain}`} target="_blank" rel="noopener noreferrer nofollow" className="text-secondary hover:underline">
            {r.organization.domain}
          </a>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    ...(rows.some((r) => labels.shown(r.organization.tags).length) ? [{ key: "labels", label: "Labels", render: (r) => <LabelChips names={r.organization.tags} max={2} /> } satisfies Column<Row>] : []),
    { key: "industry", label: "Industry", render: (r) => r.organization.industry ?? <span className="text-faint">—</span> },
    { key: "people", label: "People", sort: "people", align: "right", render: (r) => <span className="tabular-nums">{r.peopleCount || "—"}</span> },
    { key: "clients", label: "Client", render: (r) => (r.clientCategories.length ? <span className="flex gap-1">{(["current", "prospective", "past"] as const).filter((c) => r.clientCategories.includes(c)).map((c) => <CategoryBadge key={c} category={c} />)}</span> : <span className="text-faint">—</span>) },
    { key: "next", label: "Next activity", className: "max-w-60", render: (r) => <NextActivityCell next={r.next} /> },
    { key: "owner", label: "Owner", render: (r) => <OwnerCell id={r.organization.ownerId} /> },
    { key: "last", label: "Last activity", sort: "lastActivity", render: (r) => <AgoCell at={r.organization.lastActivityAt} /> },
    ...customFields
      .filter((f) => f.entityType === "organization" && f.showInTable)
      .map((f): Column<Row> => ({ key: `c-${f.key}`, label: f.label, render: (r) => formatCustomValue(f, r.organization.custom[f.key], money) || <span className="text-faint">—</span> })),
  ];
  return (
    <>
      <PageHeader title="Organizations" count={total}>
        {canEdit ? (
          <Button variant="primary" onClick={() => openCreate({ kind: "organization" })}>
            <PlusIcon />
            Organization
          </Button>
        ) : null}
      </PageHeader>
      <Toolbar>
        <SearchBox placeholder="Search name, website, industry" />
        <OwnerFilter />
        <ParentFilter parentsOption />
        {pickable.length ? (
          <Select value={listParams.get("tag") ?? ""} onChange={(e) => listParams.set({ tag: e.target.value || null })} aria-label="Label" className="w-36 [&_select]:h-8 [&_select]:text-[13px]">
            <option value="">Any label</option>
            {pickable.map((l) => (
              <option key={l.name}>{l.name}</option>
            ))}
          </Select>
        ) : null}
      </Toolbar>
      <DataTable
        columns={columns}
        rows={rows}
        rowId={rowId}
        href={(r) => `/organizations/${r.organization.id}`}
        paging={{ total, ...paging }}
        mine={(r) => r.organization.ownerId === viewer.id}
        defaultSort="name"
        empty={
          <EmptyState
            icon={BuildingOffice2Icon}
            title={filtered ? "No matching organizations" : "No organizations yet"}
            description={filtered ? "Try a different search or filter." : "Organizations group the people you work with and the clients they belong to."}
            action={filtered ? undefined : <Button variant="primary" onClick={() => openCreate({ kind: "organization" })}>Add an organization</Button>}
          />
        }
        bulk={(ids, clear, selected) => (
          <>
            <select
              className="h-7 rounded-md border border-white/20 bg-white/10 px-2 text-[12.5px] text-white"
              defaultValue=""
              onChange={async (e) => {
                const owner = e.target.value === "none" ? null : e.target.value;
                const r = await assignOwner("organization", ids, owner);
                if (!r.ok) toast.error(r.error);
                else toast.success(`${r.data.count} organizations assigned to ${owner ? member(owner)?.name : "no one"}`);
                clear();
              }}
              aria-label="Assign owner"
            >
              <option value="" disabled>
                Assign owner…
              </option>
              {team
                .filter((m) => m.active)
                .map((m) => (
                  <option key={m.id} value={m.id} className="text-primary">
                    {m.name}
                  </option>
                ))}
              <option value="none" className="text-primary">
                No owner
              </option>
            </select>
            <BulkButton
              onClick={async () => {
                const r = await setArchived("organization", ids, true);
                if (!r.ok) return void toast.error(r.error);
                toast.success(`${r.data.count} organizations archived`, { label: "Undo", onClick: () => setArchived("organization", ids, false) });
                clear();
              }}
            >
              Archive
            </BulkButton>
            {canEdit && selected.length > 1 ? <BulkButton onClick={() => setMerging({ rows: selected, done: clear })}>Merge</BulkButton> : null}
          </>
        )}
      />
      {merging ? (
        <MergeDialog
          entity="organization"
          candidates={merging.rows.map(candidate)}
          onClose={() => setMerging(null)}
          onMerged={() => {
            merging.done();
            setMerging(null);
          }}
        />
      ) : null}
    </>
  );
}
