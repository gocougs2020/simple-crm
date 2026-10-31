"use client";

import Link from "next/link";
import { useTransition } from "react";
import { PlusIcon, Squares2X2Icon, TableCellsIcon } from "@heroicons/react/20/solid";
import { CurrencyDollarIcon } from "@heroicons/react/24/outline";
import { assignOwner, savePrefs, setArchived, setDealStatus } from "@/actions/records";
import { useApp } from "@/components/app-context";
import { PageHeader } from "@/components/shell/app-shell";
import { openCreate } from "@/components/shell/create-store";
import { AgoCell, NextActivityCell, OwnerCell } from "@/components/table/cells";
import { DataTable, type Column } from "@/components/table/data-table";
import { FilterTabs, OwnerFilter, SearchBox, Toolbar } from "@/components/table/toolbar";
import { useListParams } from "@/components/table/use-params";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { formatCustomValue } from "@/components/records/custom-field-input";
import type { DealRow } from "@/lib/crm/records";
import { formatDateOnly } from "@/lib/format";
import { DealsBoard } from "./board";
import { Segmented } from "@/components/activity/composer";

export function DealsView({ deals, view, pipelineId }: { deals: DealRow[]; view: "board" | "table"; pipelineId: string }) {
  const { pipelines, money, viewer, customFields, member, team } = useApp();
  const { set } = useListParams();
  const [, start] = useTransition();
  const pipeline = pipelines.find((p) => p.id === pipelineId) ?? pipelines[0];
  const open = deals.filter((d) => d.deal.status === "open");
  const total = open.reduce((s, d) => s + d.deal.value, 0);
  const weighted = open.reduce((s, d) => s + (d.deal.value * (pipeline?.stages.find((x) => x.id === d.deal.stageId)?.probability ?? 0)) / 100, 0);

  const switchView = (v: "board" | "table") => {
    set({ view: v });
    start(() => void savePrefs({ dealsView: v }));
  };

  if (!pipeline)
    return (
      <>
        <PageHeader title="Deals" />
        <div className="p-6">
          <EmptyState icon={CurrencyDollarIcon} title="No pipeline yet" description="Create a pipeline and its stages to start tracking deals." action={<Button variant="primary" asChild><Link href="/settings/pipelines">Set up a pipeline</Link></Button>} />
        </div>
      </>
    );

  const columns: Column<DealRow>[] = [
    { key: "title", label: "Deal", sort: "title", className: "min-w-56", render: (r) => <span className="font-medium text-primary">{r.deal.title}</span> },
    { key: "value", label: "Value", sort: "value", align: "right", render: (r) => <span className="tabular-nums">{money(r.deal.value)}</span> },
    { key: "org", label: "Organization", sort: "organization", render: (r) => (r.organizationName ? <Link href={`/organizations/${r.deal.organizationId}`} className="hover:underline">{r.organizationName}</Link> : <span className="text-faint">—</span>) },
    { key: "person", label: "Person", render: (r) => (r.personFirstName ? <Link href={`/people/${r.deal.personId}`} className="hover:underline">{[r.personFirstName, r.personLastName].filter(Boolean).join(" ")}</Link> : <span className="text-faint">—</span>) },
    {
      key: "stage",
      label: "Stage",
      sort: "stage",
      render: (r) =>
        r.deal.status === "open" ? (
          <span className="whitespace-nowrap">{r.stageName}</span>
        ) : (
          <StatusBadge tone={r.deal.status === "won" ? "success" : "neutral"}>{r.deal.status === "won" ? "Won" : "Lost"}</StatusBadge>
        ),
    },
    { key: "next", label: "Next activity", className: "max-w-64", render: (r) => <NextActivityCell next={r.next} warnIfNone={r.deal.status === "open"} /> },
    { key: "close", label: "Expected close", sort: "expectedClose", render: (r) => (r.deal.expectedCloseDate ? <span className="whitespace-nowrap">{formatDateOnly(r.deal.expectedCloseDate)}</span> : <span className="text-faint">—</span>) },
    { key: "owner", label: "Owner", render: (r) => <OwnerCell id={r.deal.ownerId} /> },
    { key: "last", label: "Last activity", sort: "lastActivity", render: (r) => <AgoCell at={r.deal.lastActivityAt} /> },
    ...customFields
      .filter((f) => f.entityType === "deal" && f.showInTable)
      .map((f): Column<DealRow> => ({ key: `c-${f.key}`, label: f.label, render: (r) => formatCustomValue(f, r.deal.custom[f.key], money) || <span className="text-faint">—</span> })),
  ];

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col lg:h-dvh">
      <PageHeader
        title="Deals"
        sub={
          <p className="mt-0.5 text-[12.5px] text-muted tabular-nums">
            {open.length} open · {money(total)} · {money(Math.round(weighted))} weighted
          </p>
        }
      >
        <Button variant="primary" onClick={() => openCreate({ kind: "deal", defaults: { pipelineId: pipeline.id } })}>
          <PlusIcon />
          Deal
        </Button>
      </PageHeader>
      <Toolbar>
        <Segmented
          value={view}
          onChange={switchView}
          options={[
            { value: "board", label: "Board", icon: <Squares2X2Icon className="size-3.5" /> },
            { value: "table", label: "Table", icon: <TableCellsIcon className="size-3.5" /> },
          ]}
        />
        {pipelines.length > 1 ? (
          <Select
            value={pipeline.id}
            onChange={(e) => {
              set({ pipeline: e.target.value });
              start(() => void savePrefs({ pipelineId: e.target.value }));
            }}
            aria-label="Pipeline"
            className="w-44 [&_select]:h-8 [&_select]:text-[13px]"
          >
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        ) : null}
        <OwnerFilter />
        <SearchBox placeholder="Search deals" />
        {view === "table" ? (
          <div className="ml-auto">
            <FilterTabs
              param="status"
              fallback="open"
              options={[
                { value: "open", label: "Open" },
                { value: "won", label: "Won" },
                { value: "lost", label: "Lost" },
                { value: "all", label: "All" },
              ]}
            />
          </div>
        ) : null}
      </Toolbar>
      {view === "board" ? (
        <DealsBoard deals={deals} pipeline={pipeline} />
      ) : (
        <div className="min-h-0 flex-1">
          <DataTable
            columns={columns}
            rows={deals}
            rowId={(r) => r.deal.id}
            href={(r) => `/deals/${r.deal.id}`}
            mine={(r) => r.deal.ownerId === viewer.id}
            empty={<EmptyState icon={CurrencyDollarIcon} title="No deals match" description="Try another filter, or add a deal." />}
            bulk={(ids, clear) => (
              <>
                <select
                  className="h-7 rounded-md border border-white/20 bg-white/10 px-2 text-[12.5px] text-white"
                  defaultValue=""
                  onChange={async (e) => {
                    const owner = e.target.value === "none" ? null : e.target.value;
                    const r = await assignOwner("deal", ids, owner);
                    if (!r.ok) toast.error(r.error);
                    else toast.success(`${r.data.count} deals assigned to ${owner ? member(owner)?.name : "no one"}`);
                    clear();
                  }}
                  aria-label="Assign owner"
                >
                  <option value="" disabled>
                    Assign owner…
                  </option>
                  {team.filter((m) => m.active).map((m) => (
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
                    for (const id of ids) await setDealStatus(id, { status: "won" });
                    toast.success(`${ids.length} deals marked won`);
                    clear();
                  }}
                >
                  Mark won
                </BulkButton>
                <BulkButton
                  onClick={async () => {
                    const r = await setArchived("deal", ids, true);
                    if (!r.ok) return void toast.error(r.error);
                    toast.success(`${r.data.count} deals archived`, { label: "Undo", onClick: () => setArchived("deal", ids, false) });
                    clear();
                  }}
                >
                  Archive
                </BulkButton>
              </>
            )}
          />
        </div>
      )}
    </div>
  );
}

export function BulkButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="h-7 rounded-md border border-white/20 bg-white/10 px-2.5 text-[12.5px] font-medium text-white hover:bg-white/20">
      {children}
    </button>
  );
}
