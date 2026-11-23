"use client";

import clsx from "clsx";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
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
import { BulkAddLabels, LabelChips, useLabels } from "@/components/records/labels";
import { MergeDialog, type MergeCandidate } from "@/components/records/merge-dialog";
import { StatusBadge, Tag, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { CLIENTS_TAB_COOKIE, churnReasons, clientCategories, clientCategoryLabels, clientHealthLabels, clientHealths, type ClientCategory } from "@/lib/constants";
import { billingStatusLabels, billingStatuses, type BillingStatus } from "@/lib/stripe/rules";
import type { ClientRow } from "@/lib/crm/records";
import { formatDateOnly } from "@/lib/format";
import { BulkButton } from "./bulk-button";
import { HealthBadge } from "./client-controls";

// The board (and drag and drop) is its own chunk, loaded only when the board view renders; the table never needs it.
const ClientsBoard = dynamic(() => import("./board").then((m) => m.ClientsBoard));

/**
 * The tab last opened, for this browser session only (a cookie with no expiry
 * ends when the browser closes): Clients opens on it again after a refresh or
 * coming back from another page. The page reads it when the URL doesn't say.
 */
function rememberTab(category: ClientCategory) {
  document.cookie = `${CLIENTS_TAB_COOKIE}=${category}; path=/; samesite=lax`;
}

const billingTone: Record<BillingStatus, Tone> = { past_due: "error", active: "success", trialing: "info", paused: "warning", canceled: "neutral", customer: "neutral" };

export function ClientsView({
  rows,
  view,
  category,
  pipelineId,
  counts,
  tags,
  stripeProducts,
}: {
  rows: ClientRow[];
  view: "board" | "table";
  category: ClientCategory;
  pipelineId: string | null;
  counts: Partial<Record<ClientCategory, number>>;
  tags: string[];
  /** Stripe products clients are subscribed to now, for the filter. Empty when Stripe isn't connected. */
  stripeProducts: string[];
}) {
  const { pipelines, money, viewer, customFields, member, team, catalog, workspace, canEdit, services: connected } = useApp();
  const labels = useLabels();
  const shownTags = labels.shown(tags);
  const tz = workspace.timezone;
  const { get, set } = useListParams();
  const [, start] = useTransition();
  const options = pipelines.filter((p) => p.category === category);
  const pipeline = options.find((p) => p.id === pipelineId) ?? null;

  const [merging, setMerging] = useState<{ rows: ClientRow[]; done: () => void } | null>(null);
  const stageName = (r: ClientRow) => r.stageName ?? null;
  const candidate = (r: ClientRow): MergeCandidate => ({
    id: r.client.id,
    title: r.client.name,
    subtitle: [clientCategoryLabels[r.client.category].one, stageName(r)].filter(Boolean).join(" · "),
    createdAt: new Date(r.client.createdAt),
    lastActivityAt: r.client.lastActivityAt ? new Date(r.client.lastActivityAt) : null,
    fields: [
      { label: "Name", value: r.client.name },
      { label: "Category", value: clientCategoryLabels[r.client.category].one },
      { label: "Stage", value: stageName(r) },
      { label: "Contact", value: r.personFirstName ? [r.personFirstName, r.personLastName].filter(Boolean).join(" ") : null },
      { label: "Organization", value: r.organizationName },
      { label: "Owner", value: r.client.ownerId ? (member(r.client.ownerId)?.name ?? "A former teammate") : null },
      ...customFields.filter((f) => f.entityType === "client").map((f) => ({ label: f.label, value: formatCustomValue(f, r.client.custom[f.key], money) || null })),
    ],
    extras: [
      r.services.length ? [...new Set(r.services.map((s) => s.name))].join(", ") : null,
      r.client.stripeStatus ? `Stripe: ${billingStatusLabels[r.client.stripeStatus].toLowerCase()}` : null,
    ].filter((x): x is string => !!x),
  });

  // A link straight to a tab (?category=current) counts as opening it.
  useEffect(() => rememberTab(category), [category]);

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
        ? // Monthly revenue comes from Stripe when it's connected; the services tracked by hand are being phased out.
          `${rows.length} ${rows.length === 1 ? "client" : "clients"} · ${money(rows.reduce((s, r) => s + Number(connected.stripe ? r.client.stripeMrr : r.mrr), 0))}/mo · ${rows.filter((r) => r.client.health === "at_risk").length} at risk`
        : `${rows.length} past ${rows.length === 1 ? "client" : "clients"} · ${rows.filter((r) => r.client.openToReturn).length} open to coming back`;

  const name: Column<ClientRow> = {
    key: "name",
    // Says which tab this is, in case it's missed: "Current client".
    label: `${clientCategoryLabels[category].one} client`,
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
  const stage: Column<ClientRow> = { key: "stage", label: "Stage", sort: "stage", mobile: "meta", render: (r) => <span className="whitespace-nowrap">{r.stageName}</span> };
  /** Whether they have a subscription running in Stripe, from the daily sync. */
  const billing: Column<ClientRow> = {
    key: "billing",
    label: "Stripe",
    sort: "stripeStatus",
    mobile: "meta",
    render: (r) => (
      <span className="flex flex-wrap items-center gap-1">
        {/* Not in Stripe at all reads the same as no subscription: nothing is billing them. */}
        <StatusBadge tone={billingTone[r.client.stripeStatus ?? "customer"]}>{billingStatusLabels[r.client.stripeStatus ?? "customer"]}</StatusBadge>
        {r.client.stripeOwed ? <span className="text-[12.5px] text-warning tabular-nums">{money(r.client.stripeOwed)} owed</span> : null}
      </span>
    ),
  };
  /**
   * What they're signed up for: the products on their running Stripe
   * subscriptions. Without Stripe connected, the services tracked by hand:
   * the ones they have, or on the Past tab the ones they had.
   */
  const services: Column<ClientRow> = {
    key: "services",
    label: "Services",
    className: "max-w-64",
    render: (r) => {
      const list = connected.stripe ? r.client.stripeProducts : [...new Set(r.services.filter((s) => s.active === (category !== "past")).map((s) => s.name))];
      return list.length ? (
        <span className="flex flex-wrap gap-1">
          {list.map((name) => (
            <Tag key={name}>{name}</Tag>
          ))}
        </span>
      ) : (
        <span className="text-faint">—</span>
      );
    },
  };
  const tagCol: Column<ClientRow> = {
    key: "tags",
    label: "Labels",
    render: (r) =>
      labels.shown(r.client.tags).length ? (
        <LabelChips names={r.client.tags} />
      ) : (
        <span className="text-faint">—</span>
      ),
  };
  const next: Column<ClientRow> = {
    key: "next",
    label: "Next activity",
    className: "max-w-64",
    mobile: "meta",
    mobileRender: (r) => (r.next?.dueAt || category !== "past" ? <NextActivityCell next={r.next} warnIfNone={category !== "past"} /> : null),
    render: (r) => <NextActivityCell next={r.next} warnIfNone={category !== "past"} />,
  };
  const owner: Column<ClientRow> = { key: "owner", label: "Owner", render: (r) => <OwnerCell id={r.client.ownerId} /> };
  const last: Column<ClientRow> = { key: "last", label: "Last activity", sort: "lastActivity", render: (r) => <AgoCell at={r.client.lastActivityAt} /> };
  const date = (field: "expectedCloseDate" | "startedOn" | "endedOn", label: string, sort: string): Column<ClientRow> => ({
    key: field,
    label,
    sort,
    render: (r) => (r.client[field] ? <span className="whitespace-nowrap">{formatDateOnly(r.client[field]!, tz)}</span> : <span className="text-faint">—</span>),
  });
  const health: Column<ClientRow> = { key: "health", label: "Health", mobile: "meta", mobileRender: (r) => (r.client.health ? <HealthBadge health={r.client.health} /> : null), render: (r) => (r.client.health ? <HealthBadge health={r.client.health} /> : <span className="text-faint">—</span>) };
  const stripe = connected.stripe ? [billing] : [];

  // One order on every tab: who, who has it, who we talk to, what's next, what they pay for, how it's going, where it stands, since when.
  // Each tab puts its own "how it's going" and date in those places.
  const byCategory: Record<ClientCategory, Column<ClientRow>[]> = {
    prospective: [name, owner, contact, next, ...stripe, services, { key: "value", label: "Potential value", sort: "value", align: "right", mobile: "end", render: (r) => <span className="tabular-nums">{money(r.client.value)}</span> }, stage, date("expectedCloseDate", "Expected to sign", "expectedClose"), last],
    current: [name, owner, contact, next, ...stripe, services, health, stage, date("startedOn", "Client since", "startedOn"), last],
    past: [
      name,
      owner,
      contact,
      next,
      ...stripe,
      services,
      { key: "reason", label: "Why they left", className: "max-w-56", render: (r) => (r.client.churnReason ? <span className="truncate">{r.client.churnReason}</span> : <span className="text-faint">—</span>) },
      { key: "return", label: "Win back", render: (r) => (r.client.openToReturn ? <span className="text-secondary">Open</span> : <span className="text-faint">Not interested</span>) },
      stage,
      date("endedOn", "Left", "endedOn"),
      last,
    ],
  };
  const columns: Column<ClientRow>[] = [
    ...byCategory[category],
    ...(shownTags.length ? [tagCol] : []),
    ...customFields
      .filter((f) => f.entityType === "client" && f.showInTable)
      .map((f): Column<ClientRow> => ({ key: `c-${f.key}`, label: f.label, render: (r) => formatCustomValue(f, r.client.custom[f.key], money) || <span className="text-faint">—</span> })),
  ];

  const filterSelect = (param: string, label: string, choices: { value: string; label: string }[]) => (
    <Select value={get(param) ?? ""} onChange={(e) => set({ [param]: e.target.value || null })} aria-label={label} className="w-44 [&_select]:h-8 pointer-coarse:[&_select]:h-10 [&_select]:text-[13px]">
      <option value="">{label}</option>
      {choices.map((c) => (
        <option key={c.value} value={c.value}>
          {c.label}
        </option>
      ))}
    </Select>
  );

  return (
    // The board fills the screen; on a phone the table is a list that scrolls with the page.
    <div className={clsx("flex flex-col", view === "board" ? "h-app" : "sm:h-app")}>
      <PageHeader title="Clients" sub={<p className="mt-0.5 text-[12.5px] text-muted tabular-nums">{summary}</p>}>
        {canEdit ? (
          <Button variant="primary" onClick={() => openCreate({ kind: "client", defaults: { category, stageId: pipeline?.stages[0]?.id } })}>
            <PlusIcon />
            Client
          </Button>
        ) : null}
      </PageHeader>
      <nav className="flex gap-1 border-b border-line px-4 lg:px-6" aria-label="Client categories">
        {clientCategories.map((c) => (
          <button
            key={c}
            type="button"
            aria-current={c === category ? "page" : undefined}
            onClick={() => {
              rememberTab(c);
              set({ category: c === "prospective" ? null : c, pipeline: null, health: null, service: null, reason: null, billing: null, product: null, sort: null, dir: null });
            }}
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
            className="w-44 [&_select]:h-8 pointer-coarse:[&_select]:h-10 [&_select]:text-[13px]"
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
        {connected.stripe ? filterSelect("billing", "Any billing", [...billingStatuses.map((b) => ({ value: b, label: billingStatusLabels[b] })), { value: "none", label: "Not in Stripe" }]) : null}
        {stripeProducts.length ? filterSelect("product", "Any Stripe product", stripeProducts.map((p) => ({ value: p, label: p }))) : null}
        {shownTags.length ? filterSelect("tag", "Any label", shownTags.map((t) => ({ value: t, label: t }))) : null}
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
            bulk={(ids, clear, selected) => (
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
                <BulkAddLabels entity="client" ids={ids} onDone={clear} />
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
                {canEdit && selected.length > 1 ? <BulkButton onClick={() => setMerging({ rows: selected, done: clear })}>Merge</BulkButton> : null}
              </>
            )}
          />
        </div>
      )}
      {merging ? (
        <MergeDialog
          entity="client"
          candidates={merging.rows.map(candidate)}
          onClose={() => setMerging(null)}
          onMerged={() => {
            merging.done();
            setMerging(null);
          }}
        />
      ) : null}
    </div>
  );
}
