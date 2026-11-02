"use client";

import clsx from "clsx";
import Link from "next/link";
import { useTransition } from "react";
import { PlusIcon, Squares2X2Icon, TableCellsIcon } from "@heroicons/react/20/solid";
import { BriefcaseIcon } from "@heroicons/react/24/outline";
import { assignOwner, savePrefs, setArchived } from "@/actions/records";
import { Segmented } from "@/components/activity/composer";
import { useApp } from "@/components/app-context";
import { formatCustomValue } from "@/components/records/custom-field-input";
import { PageHeader } from "@/components/shell/app-shell";
import { openCreate } from "@/components/shell/create-store";
import { AgoCell, NextActivityCell, OwnerCell } from "@/components/table/cells";
import { DataTable, type Column } from "@/components/table/data-table";
import { OwnerFilter, SearchBox, Toolbar } from "@/components/table/toolbar";
import { useListParams } from "@/components/table/use-params";
import { Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { churnReasons, clientCategories, clientCategoryLabels, clientHealthLabels, clientHealths, type ClientCategory } from "@/lib/constants";
import type { ClientRow } from "@/lib/crm/records";
import { formatDateOnly } from "@/lib/format";
import { ClientsBoard } from "./board";
import { HealthBadge } from "./client-controls";

export function ClientsView({
  rows,
  view,
  category,
  pipelineId,
  counts,
  tags,
}: {
  rows: ClientRow[];
  view: "board" | "table";
  category: ClientCategory;
  pipelineId: string | null;
  counts: Partial<Record<ClientCategory, number>>;
  tags: string[];
}) {
  const { pipelines, money, viewer, customFields, member, team, catalog, workspace } = useApp();
  const tz = workspace.timezone;
  const { get, set } = useListParams();
  const [, start] = useTransition();
  const options = pipelines.filter((p) => p.category === category);
  const pipeline = options.find((p) => p.id === pipelineId) ?? null;

  const switchView = (v: "board" | "table") => {
    set({ view: v });
    start(() => void savePrefs({ clientsView: v }));
  };

  const summary =
    category === "prospective"
      ? (() => {
          const total = rows.reduce((s, r) => s + r.client.value, 0);
          const weighted = rows.reduce((s, r) => s + (r.client.value * (pipelines.flatMap((p) => p.stages).find((x) => x.id === r.client.stageId)?.probability ?? 0)) / 100, 0);
          return `${rows.length} ${rows.length === 1 ? "prospect" : "prospects"} · ${money(total)} potential · ${money(Math.round(weighted))} weighted`;
        })()
      : category === "current"
        ? `${rows.length} ${rows.length === 1 ? "client" : "clients"} · ${money(rows.reduce((s, r) => s + Number(r.mrr), 0))}/mo · ${rows.filter((r) => r.client.health === "at_risk").length} at risk`
        : `${rows.length} past ${rows.length === 1 ? "client" : "clients"} · ${rows.filter((r) => r.client.openToReturn).length} open to coming back`;

  const name: Column<ClientRow> = {
    key: "name",
    label: "Client",
    sort: "name",
    className: "min-w-56",
    render: (r) => (
      <span className="flex flex-col">
        <span className="font-medium text-primary">{r.client.name}</span>
        {r.organizationName && r.organizationName !== r.client.name ? <span className="text-[12px] text-muted">{r.organizationName}</span> : null}
      </span>
    ),
  };
  const contact: Column<ClientRow> = {
    key: "person",
    label: "Contact",
    render: (r) => (r.personFirstName ? <Link href={`/people/${r.client.personId}`} className="hover:underline">{[r.personFirstName, r.personLastName].filter(Boolean).join(" ")}</Link> : <span className="text-faint">—</span>),
  };
  const stage: Column<ClientRow> = { key: "stage", label: "Stage", sort: "stage", render: (r) => <span className="whitespace-nowrap">{r.stageName}</span> };
  const services = (active: boolean): Column<ClientRow> => ({
    key: "services",
    label: active ? "Services" : "Had",
    className: "max-w-64",
    render: (r) => {
      const list = r.services.filter((s) => s.active === active);
      return list.length ? (
        <span className="flex flex-wrap gap-1">
          {list.map((s) => (
            <Tag key={s.name}>{s.name}</Tag>
          ))}
        </span>
      ) : (
        <span className="text-faint">—</span>
      );
    },
  });
  const tagCol: Column<ClientRow> = {
    key: "tags",
    label: "Tags",
    render: (r) =>
      r.client.tags.length ? (
        <span className="flex flex-wrap gap-1">
          {r.client.tags.map((t) => (
            <Tag key={t}>{t}</Tag>
          ))}
        </span>
      ) : (
        <span className="text-faint">—</span>
      ),
  };
  const next: Column<ClientRow> = { key: "next", label: "Next activity", className: "max-w-64", render: (r) => <NextActivityCell next={r.next} warnIfNone={category !== "past"} /> };
  const owner: Column<ClientRow> = { key: "owner", label: "Owner", render: (r) => <OwnerCell id={r.client.ownerId} /> };
  const last: Column<ClientRow> = { key: "last", label: "Last activity", sort: "lastActivity", render: (r) => <AgoCell at={r.client.lastActivityAt} /> };
  const date = (field: "expectedCloseDate" | "startedOn" | "endedOn", label: string, sort: string): Column<ClientRow> => ({
    key: field,
    label,
    sort,
    render: (r) => (r.client[field] ? <span className="whitespace-nowrap">{formatDateOnly(r.client[field]!, tz)}</span> : <span className="text-faint">—</span>),
  });
  const monthly = (field: "mrr" | "formerMrr", label: string): Column<ClientRow> => ({
    key: field,
    label,
    sort: field,
    align: "right",
    render: (r) => (Number(r[field]) ? <span className="tabular-nums">{money(Number(r[field]))}/mo</span> : <span className="text-faint">—</span>),
  });

  const byCategory: Record<ClientCategory, Column<ClientRow>[]> = {
    prospective: [name, { key: "value", label: "Potential value", sort: "value", align: "right", render: (r) => <span className="tabular-nums">{money(r.client.value)}</span> }, contact, stage, next, date("expectedCloseDate", "Expected to sign", "expectedClose"), owner, last],
    current: [name, monthly("mrr", "Monthly"), services(true), { key: "health", label: "Health", render: (r) => (r.client.health ? <HealthBadge health={r.client.health} /> : <span className="text-faint">—</span>) }, stage, next, date("startedOn", "Client since", "startedOn"), owner, last],
    past: [
      name,
      monthly("formerMrr", "Was paying"),
      services(false),
      { key: "reason", label: "Why they left", className: "max-w-56", render: (r) => (r.client.churnReason ? <span className="truncate">{r.client.churnReason}</span> : <span className="text-faint">—</span>) },
      { key: "return", label: "Win back", render: (r) => (r.client.openToReturn ? <span className="text-secondary">Open</span> : <span className="text-faint">Not interested</span>) },
      stage,
      date("endedOn", "Left", "endedOn"),
      contact,
      owner,
    ],
  };
  const columns: Column<ClientRow>[] = [
    ...byCategory[category],
    ...(tags.length ? [tagCol] : []),
    ...customFields
      .filter((f) => f.entityType === "client" && f.showInTable)
      .map((f): Column<ClientRow> => ({ key: `c-${f.key}`, label: f.label, render: (r) => formatCustomValue(f, r.client.custom[f.key], money) || <span className="text-faint">—</span> })),
  ];

  const filterSelect = (param: string, label: string, choices: { value: string; label: string }[]) => (
    <Select value={get(param) ?? ""} onChange={(e) => set({ [param]: e.target.value || null })} aria-label={label} className="w-44 [&_select]:h-8 [&_select]:text-[13px]">
      <option value="">{label}</option>
      {choices.map((c) => (
        <option key={c.value} value={c.value}>
          {c.label}
        </option>
      ))}
    </Select>
  );

  return (
    <div className="flex h-[calc(100dvh-3rem)] flex-col lg:h-dvh">
      <PageHeader title="Clients" sub={<p className="mt-0.5 text-[12.5px] text-muted tabular-nums">{summary}</p>}>
        <Button variant="primary" onClick={() => openCreate({ kind: "client", defaults: { category, stageId: pipeline?.stages[0]?.id } })}>
          <PlusIcon />
          Client
        </Button>
      </PageHeader>
      <nav className="flex gap-1 border-b border-line px-4 lg:px-6" aria-label="Client categories">
        {clientCategories.map((c) => (
          <button
            key={c}
            type="button"
            aria-current={c === category ? "page" : undefined}
            onClick={() => set({ category: c === "prospective" ? null : c, pipeline: null, health: null, service: null, reason: null, sort: null, dir: null })}
            className={clsx("-mb-px border-b-2 px-2.5 py-2.5 text-[13.5px] font-medium", c === category ? "border-accent text-primary" : "border-transparent text-muted hover:text-secondary")}
          >
            {clientCategoryLabels[c].many}
            <span className="ml-1.5 text-[12px] font-normal text-muted tabular-nums">{counts[c] ?? 0}</span>
          </button>
        ))}
      </nav>
      <Toolbar>
        <Segmented
          value={view}
          onChange={switchView}
          options={[
            { value: "board", label: "Board", icon: <Squares2X2Icon className="size-3.5" /> },
            { value: "table", label: "Table", icon: <TableCellsIcon className="size-3.5" /> },
          ]}
        />
        {options.length > 1 || view === "table" ? (
          <Select
            value={pipeline?.id ?? ""}
            onChange={(e) => {
              set({ pipeline: e.target.value || null });
              if (e.target.value) start(() => void savePrefs({ clientPipelines: { [category]: e.target.value } }));
            }}
            aria-label="Pipeline"
            className="w-44 [&_select]:h-8 [&_select]:text-[13px]"
          >
            {view === "table" ? <option value="">All pipelines</option> : null}
            {options.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        ) : null}
        <OwnerFilter />
        <SearchBox placeholder={`Search ${clientCategoryLabels[category].one.toLowerCase()} clients`} />
        {category === "current" ? filterSelect("health", "Any health", [...clientHealths.map((h) => ({ value: h, label: clientHealthLabels[h] })), { value: "none", label: "Not set" }]) : null}
        {category !== "prospective" && catalog.length ? filterSelect("service", "Any service", catalog.map((s) => ({ value: s.id, label: s.name }))) : null}
        {category === "past" ? filterSelect("reason", "Any reason", churnReasons.map((r) => ({ value: r, label: r }))) : null}
        {tags.length ? filterSelect("tag", "Any tag", tags.map((t) => ({ value: t, label: t }))) : null}
      </Toolbar>
      {!options.length ? (
        <div className="p-6">
          <EmptyState
            icon={BriefcaseIcon}
            title={`No pipeline for ${clientCategoryLabels[category].one.toLowerCase()} clients`}
            description="Create a pipeline and its stages to start tracking clients here."
            action={
              <Button variant="primary" asChild>
                <Link href="/settings/pipelines">Set up a pipeline</Link>
              </Button>
            }
          />
        </div>
      ) : view === "board" && pipeline ? (
        <ClientsBoard rows={rows} pipeline={pipeline} category={category} />
      ) : (
        <div className="min-h-0 flex-1">
          <DataTable
            columns={columns}
            rows={rows}
            rowId={(r) => r.client.id}
            href={(r) => `/clients/${r.client.id}`}
            mine={(r) => r.client.ownerId === viewer.id}
            empty={<EmptyState icon={BriefcaseIcon} title="No clients match" description="Try another filter, or add a client." />}
            bulk={(ids, clear) => (
              <>
                <select
                  className="h-7 rounded-md border border-white/20 bg-white/10 px-2 text-[12.5px] text-white"
                  defaultValue=""
                  onChange={async (e) => {
                    const ownerId = e.target.value === "none" ? null : e.target.value;
                    const r = await assignOwner("client", ids, ownerId);
                    if (!r.ok) toast.error(r.error);
                    else toast.success(`${r.data.count} clients assigned to ${ownerId ? member(ownerId)?.name : "no one"}`);
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
                    const r = await setArchived("client", ids, true);
                    if (!r.ok) return void toast.error(r.error);
                    toast.success(`${r.data.count} clients archived`, { label: "Undo", onClick: () => setArchived("client", ids, false) });
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
