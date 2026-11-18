"use client";

import { StarIcon } from "@heroicons/react/20/solid";
import { appConfig } from "@/app.config";

import Link from "next/link";
import { useCallback, useState } from "react";
import { ArrowUpTrayIcon, PlusIcon } from "@heroicons/react/20/solid";
import { UserIcon } from "@heroicons/react/24/outline";
import { addTag, assignOwner, morePeople, setArchived } from "@/actions/records";
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
import { useListParams } from "@/components/table/use-params";
import { MergeDialog, type MergeCandidate } from "@/components/records/merge-dialog";
import { Avatar } from "@/components/ui/avatar";
import { LabelChips, useLabels } from "@/components/records/labels";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import type { listPeople, PeopleFilter } from "@/lib/crm/records";
import { personName } from "@/lib/format";
import { ImportDialog } from "./import-dialog";

type Row = Awaited<ReturnType<typeof listPeople>>[number];

const rowId = (r: Row) => r.person.id;

export function PeopleView({ rows: first, total, filter, pageSize, tags, filtered }: { rows: Row[]; total: number; filter: PeopleFilter; pageSize: number; tags: string[]; filtered: boolean }) {
  const labels = useLabels();
  // What the filter and the bulk action offer: labels the app shows.
  const shownTags = labels.shown(tags);
  const pickable = labels.all.filter((l) => !l.hidden);
  const { viewer, customFields, money, team, member, canEdit } = useApp();
  const { get, set } = useListParams();
  const [importing, setImporting] = useState(false);
  const [merging, setMerging] = useState<{ rows: Row[]; done: () => void } | null>(null);
  const filterKey = JSON.stringify(filter);
  const fetchPage = useCallback((offset: number, limit: number) => morePeople(JSON.parse(filterKey), { offset, limit }), [filterKey]);
  const paging = usePagedRows({ first, total, filterKey, rowId, pageSize, fetchPage });
  const rows = paging.rows;

  const candidate = (r: Row): MergeCandidate => ({
    id: r.person.id,
    title: personName(r.person),
    subtitle: r.person.email ?? r.person.phone,
    createdAt: r.person.createdAt,
    lastActivityAt: r.person.lastActivityAt,
    fields: [
      { label: "First name", value: r.person.firstName },
      { label: "Last name", value: r.person.lastName },
      { label: "Email", value: r.person.email },
      { label: "Phone", value: r.person.phone },
      { label: "Job title", value: r.person.title },
      { label: "Organization", value: r.organizationName },
      { label: "Owner", value: r.person.ownerId ? (member(r.person.ownerId)?.name ?? "A former teammate") : null },
      ...customFields.filter((f) => f.entityType === "person").map((f) => ({ label: f.label, value: formatCustomValue(f, r.person.custom[f.key], money) || null })),
    ],
    extras: [r.clientCategories.length ? "Client contact" : null, r.person.tags.length ? `${r.person.tags.length} ${r.person.tags.length === 1 ? "label" : "labels"}` : null].filter((x): x is string => !!x),
  });

  const columns: Column<Row>[] = [
    {
      key: "name",
      label: "Name",
      sort: "name",
      className: "min-w-52",
      render: (r) => (
        <span className="flex items-center gap-2.5">
          <Avatar name={personName(r.person)} size="sm" />
          <span className="min-w-0">
            <span className="flex items-center gap-1 truncate font-medium text-primary">
              <span className="truncate">{personName(r.person)}</span>
              {r.person.decisionMaker ? <StarIcon className="size-3.5 shrink-0 text-warning" aria-label={appConfig.records.keyContactLabel} /> : null}
            </span>
            {r.person.title ? <span className="block truncate text-[12px] text-muted">{r.person.title}</span> : null}
          </span>
        </span>
      ),
    },
    {
      key: "org",
      label: "Organization",
      sort: "organization",
      render: (r) => (r.organizationName ? <Link href={`/organizations/${r.person.organizationId}`} className="hover:underline">{r.organizationName}</Link> : <span className="text-faint">—</span>),
    },
    { key: "email", label: "Email", render: (r) => (r.person.email ? <a href={`mailto:${r.person.email}`} className="text-secondary hover:underline">{r.person.email}</a> : <span className="text-faint">—</span>) },
    { key: "phone", label: "Phone", render: (r) => (r.person.phone ? <a href={`tel:${r.person.phone.replace(/[^\d+]/g, "")}`} className="whitespace-nowrap text-secondary hover:underline">{r.person.phone}</a> : <span className="text-faint">—</span>) },
    { key: "clients", label: "Client", render: (r) => (r.clientCategories.length ? <span className="flex gap-1">{(["current", "prospective", "past"] as const).filter((c) => r.clientCategories.includes(c)).map((c) => <CategoryBadge key={c} category={c} />)}</span> : <span className="text-faint">—</span>) },
    { key: "next", label: "Next activity", className: "max-w-60", render: (r) => <NextActivityCell next={r.next} /> },
    { key: "tags", label: "Labels", render: (r) => <LabelChips names={r.person.tags} carried={r.organizationTags?.length && r.organizationName ? { names: r.organizationTags, from: r.organizationName } : null} max={2} /> },
    { key: "owner", label: "Owner", render: (r) => <OwnerCell id={r.person.ownerId} /> },
    { key: "last", label: "Last activity", sort: "lastActivity", render: (r) => <AgoCell at={r.person.lastActivityAt} /> },
    { key: "campaign", label: "Last campaign", sort: "lastCampaign", render: (r) => <AgoCell at={r.person.lastCampaignAt} /> },
    ...customFields
      .filter((f) => f.entityType === "person" && f.showInTable)
      .map((f): Column<Row> => ({ key: `c-${f.key}`, label: f.label, render: (r) => formatCustomValue(f, r.person.custom[f.key], money) || <span className="text-faint">—</span> })),
  ];

  return (
    <>
      <PageHeader title="People" count={total}>
        {canEdit ? (
          <>
            <Button variant="outline" onClick={() => setImporting(true)}>
              <ArrowUpTrayIcon />
              Import
            </Button>
            <Button variant="primary" onClick={() => openCreate({ kind: "person" })}>
              <PlusIcon />
              Person
            </Button>
          </>
        ) : null}
      </PageHeader>
      <Toolbar>
        <SearchBox placeholder="Search name, email, phone" />
        <OwnerFilter />
        <ParentFilter />
        {shownTags.length ? (
          <Select value={get("tag") ?? ""} onChange={(e) => set({ tag: e.target.value || null })} aria-label="Label" className="w-36 [&_select]:h-8 [&_select]:text-[13px]">
            <option value="">Any label</option>
            {shownTags.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
        ) : null}
      </Toolbar>
      <DataTable
        columns={columns}
        rows={rows}
        rowId={rowId}
        href={(r) => `/people/${r.person.id}`}
        paging={{ total, ...paging }}
        mine={(r) => r.person.ownerId === viewer.id}
        defaultSort="name"
        empty={
          filtered ? (
            <EmptyState icon={UserIcon} title="No matching people" description="Try a different search or filter." />
          ) : (
            <EmptyState
              icon={UserIcon}
              title="No people yet"
              description="Add the people you work with, or import them from a spreadsheet."
              action={
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setImporting(true)}>
                    Import a spreadsheet
                  </Button>
                  <Button variant="primary" onClick={() => openCreate({ kind: "person" })}>
                    Add a person
                  </Button>
                </div>
              }
            />
          )
        }
        bulk={(ids, clear, selected) => (
          <>
            <select
              className="h-7 rounded-md border border-white/20 bg-white/10 px-2 text-[12.5px] text-white"
              defaultValue=""
              onChange={async (e) => {
                const owner = e.target.value === "none" ? null : e.target.value;
                const r = await assignOwner("person", ids, owner);
                if (!r.ok) toast.error(r.error);
                else toast.success(`${r.data.count} people assigned to ${owner ? member(owner)?.name : "no one"}`);
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
            {pickable.length ? (
              <select
                className="h-7 rounded-md border border-white/20 bg-white/10 px-2 text-[12.5px] text-white"
                defaultValue=""
                onChange={async (e) => {
                  const label = e.target.value;
                  const r = await addTag(ids, label);
                  if (!r.ok) return void toast.error(r.error);
                  toast.success(`${r.data.count} ${r.data.count === 1 ? "person" : "people"} labeled ${label}`);
                  clear();
                }}
                aria-label="Add label"
              >
                <option value="" disabled>
                  Add label…
                </option>
                {pickable.map((l) => (
                  <option key={l.name} value={l.name} className="text-primary">
                    {l.name}
                  </option>
                ))}
              </select>
            ) : null}
            <BulkButton
              onClick={async () => {
                const r = await setArchived("person", ids, true);
                if (!r.ok) return void toast.error(r.error);
                toast.success(`${r.data.count} people archived`, { label: "Undo", onClick: () => setArchived("person", ids, false) });
                clear();
              }}
            >
              Archive
            </BulkButton>
            {canEdit && selected.length > 1 ? <BulkButton onClick={() => setMerging({ rows: selected, done: clear })}>Merge</BulkButton> : null}
          </>
        )}
      />
      {importing ? <ImportDialog onClose={() => setImporting(false)} /> : null}
      {merging ? (
        <MergeDialog
          entity="person"
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
