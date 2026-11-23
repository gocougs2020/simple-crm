"use client";

import clsx from "clsx";
import Link from "next/link";
import { useCallback, useState, useTransition, type ReactNode } from "react";
import { ArrowPathIcon, ExclamationTriangleIcon, LinkIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { BanknotesIcon, CreditCardIcon, DocumentTextIcon } from "@heroicons/react/24/outline";
import { moreBillingActivity, moreStripeCustomers, syncStripeNow } from "@/actions/billing-page";
import { removeStripeCustomer } from "@/actions/clients";
import { useApp } from "@/components/app-context";
import { PageHeader } from "@/components/shell/app-shell";
import { DataTable, type Column } from "@/components/table/data-table";
import { FilterTabs, SearchBox, Toolbar } from "@/components/table/toolbar";
import { usePagedRows } from "@/components/table/use-paged-rows";
import { useListParams } from "@/components/table/use-params";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Select } from "@/components/ui/field";
import { Tooltip } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { formatAgo, formatMoney } from "@/lib/format";
import { activityStateLabels, activityStates, type ActivityFilter, type ActivityRow, type ActivityTotals, type MappedClient, type MappingFilter, type MappingRow } from "@/lib/stripe/activity";
import { MapCustomerDialog, type MapTarget } from "./map-customer-dialog";

type Account = { id: string; label: string };

type Props =
  | { connected: false }
  | {
      connected: true;
      tab: "activity" | "mapping";
      accounts: Account[];
      syncedAt: string | null;
      unmappedCustomers: number;
      activity?: { rows: ActivityRow[]; totals: ActivityTotals; filter: ActivityFilter; pageSize: number };
      mapping?: { rows: MappingRow[]; total: number; filter: MappingFilter; pageSize: number };
    };

const money = (cents: number, currency: string | null) => formatMoney(cents, (currency ?? "usd").toUpperCase());
/** "Dec 3, 2026": Stripe's dates, in UTC like the billing card. */
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const customerTitle = (r: { name: string | null; email: string | null; id: string | null }) => r.name || r.email || r.id || "No customer";

/**
 * The Billing page: every invoice and payment in Stripe, matched to clients
 * the same way their pages are, and a tab for mapping the customers that
 * match nobody. A row whose customer no client has is tinted and flagged, so
 * it stands out in the activity.
 */
export function BillingView(props: Props) {
  if (!props.connected)
    return (
      <>
        <PageHeader title="Billing" />
        <div className="px-4 py-6 lg:px-6">
          <EmptyState icon={CreditCardIcon} title="Stripe isn't connected" description="Add a STRIPE_SECRET_KEY to the environment and redeploy. Invoices and payments show here after the first sync." />
        </div>
      </>
    );
  const { tab, accounts, syncedAt, unmappedCustomers } = props;
  return (
    <>
      <BillingHeader syncedAt={syncedAt} />
      <div className="flex items-center gap-2 px-4 pt-3 lg:px-6">
        <div className="inline-flex rounded-md border border-line bg-sunken p-0.5" role="tablist" aria-label="Billing">
          <TabLink href="/billing" active={tab === "activity"}>
            Activity
          </TabLink>
          <TabLink href="/billing?tab=mapping" active={tab === "mapping"}>
            Customer mapping
            {unmappedCustomers ? (
              <span className="ml-1.5 rounded-full bg-warning-surface px-1.5 text-[11px] font-semibold text-warning tabular-nums" aria-label={`${unmappedCustomers} not mapped`}>
                {unmappedCustomers.toLocaleString()}
              </span>
            ) : null}
          </TabLink>
        </div>
      </div>
      {tab === "activity" && props.activity ? <ActivityTab {...props.activity} accounts={accounts} /> : null}
      {tab === "mapping" && props.mapping ? <MappingTab {...props.mapping} accounts={accounts} /> : null}
    </>
  );
}

function TabLink({ href, active, children }: { href: string; active: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      role="tab"
      aria-selected={active}
      className={clsx(
        "inline-flex h-7 items-center rounded-[5px] px-2.5 text-[12.5px] font-medium transition-colors pointer-coarse:h-9 pointer-coarse:px-3 pointer-coarse:text-[13.5px]",
        active ? "bg-surface text-primary shadow-sm" : "text-muted hover:text-secondary",
      )}
    >
      {children}
    </Link>
  );
}

function BillingHeader({ syncedAt }: { syncedAt: string | null }) {
  const { isAdmin, workspace } = useApp();
  const [pending, start] = useTransition();
  const sync = () =>
    start(async () => {
      const r = await syncStripeNow();
      if (!r.ok) return void toast.error(r.error);
      if (r.data.failed.length) toast.error(`Stripe didn't answer for ${r.data.failed.join(", ")}. The rest is up to date; that account keeps its last copy.`);
      else toast.success("Billing is up to date with Stripe");
    });
  return (
    <PageHeader
      title="Billing"
      sub={
        <p className="mt-0.5 text-[12.5px] text-muted">
          Every invoice and payment in Stripe, matched to clients by their people&apos;s emails.{" "}
          <span suppressHydrationWarning>{syncedAt ? `Copied from Stripe ${formatAgo(syncedAt, workspace.timezone)}.` : "Not copied from Stripe yet."}</span>
        </p>
      }
    >
      {isAdmin ? (
        <Button size="sm" onClick={sync} loading={pending}>
          {!pending ? <ArrowPathIcon /> : null}
          Sync now
        </Button>
      ) : null}
    </PageHeader>
  );
}

const sumText = (byCurrency: Record<string, number>, fallback: string) => {
  const parts = Object.entries(byCurrency).map(([c, v]) => money(v, c));
  return parts.length ? parts.join(" + ") : formatMoney(0, fallback);
};

function Stat({ label, value, note, tone, action }: { label: string; value: ReactNode; note?: ReactNode; tone?: "warning" | "error"; action?: ReactNode }) {
  return (
    <div className={clsx("min-w-0 rounded-lg border bg-surface px-3.5 py-2.5", tone === "warning" ? "border-warning-border bg-warning-surface/40" : "border-line")}>
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <div className={clsx("mt-0.5 truncate text-[17px] font-semibold tabular-nums", tone === "warning" ? "text-warning" : tone === "error" ? "text-error" : "text-primary")}>{value}</div>
      {note || action ? (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
          {note}
          {action}
        </div>
      ) : null}
    </div>
  );
}

// ─── Activity ────────────────────────────────────────────────────────────

const kindIcon = { invoice: DocumentTextIcon, payment: BanknotesIcon };
const activityRowId = (r: ActivityRow) => `${r.account}:${r.id}`;

function ActivityTab({ rows: first, totals, filter, pageSize, accounts }: { rows: ActivityRow[]; totals: ActivityTotals; filter: ActivityFilter; pageSize: number; accounts: Account[] }) {
  const { canEdit, workspace } = useApp();
  const { get, set } = useListParams();
  const [mapping, setMapping] = useState<MapTarget | null>(null);
  const filterKey = JSON.stringify(filter);
  const fetchPage = useCallback((offset: number, limit: number) => moreBillingActivity(JSON.parse(filterKey), { offset, limit }), [filterKey]);
  const paging = usePagedRows({ first, total: totals.rows, filterKey, rowId: activityRowId, pageSize, fetchPage });
  const several = accounts.length > 1;
  const accountLabel = (id: string) => accounts.find((a) => a.id === id)?.label ?? id;
  const filtered = !!(filter.q || filter.kind || filter.state || filter.mapped || filter.account || filter.from || filter.to);

  const columns: Column<ActivityRow>[] = [
    {
      key: "customer",
      label: "Customer",
      sort: "customer",
      className: "min-w-52 max-w-72",
      render: (r) => (
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate font-medium text-primary">{customerTitle({ name: r.customerName, email: r.customerEmail, id: r.customerId })}</span>
          {r.customerEmail && r.customerName ? <span className="truncate text-[12px] text-muted">{r.customerEmail}</span> : null}
        </span>
      ),
    },
    {
      key: "client",
      label: "Client",
      sort: "client",
      mobile: "meta",
      className: "max-w-64",
      render: (r) => <ClientsCell row={r} canEdit={canEdit} onMap={() => r.customerId && setMapping({ account: r.account, customerId: r.customerId, name: r.customerName, email: r.customerEmail })} />,
    },
    {
      key: "kind",
      label: "Type",
      sort: "kind",
      mobile: "meta",
      render: (r) => {
        const Icon = kindIcon[r.kind];
        const detail = r.kind === "invoice" ? r.number : r.method;
        return (
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <Icon className="size-4 shrink-0 text-faint" aria-hidden />
            <span className="text-secondary">{r.kind === "invoice" ? "Invoice" : "Payment"}</span>
            {detail ? <span className="truncate text-[12px] text-muted">{detail}</span> : null}
          </span>
        );
      },
    },
    { key: "date", label: "Date", sort: "date", mobile: "meta", render: (r) => <span className="text-secondary tabular-nums">{day(r.createdAt)}</span> },
    { key: "state", label: "Status", sort: "state", mobile: "meta", render: (r) => <StateBadge row={r} /> },
    {
      key: "amount",
      label: "Amount",
      sort: "amount",
      align: "right",
      mobile: "end",
      render: (r) => (
        <span className="flex flex-col items-end leading-tight">
          <span className="font-medium text-primary tabular-nums">{money(r.amount, r.currency)}</span>
          {r.refunded ? <span className="text-[12px] text-muted tabular-nums">{money(r.refunded, r.currency)} refunded</span> : r.remaining && r.remaining !== r.amount ? <span className="text-[12px] text-muted tabular-nums">{money(r.remaining, r.currency)} left</span> : null}
        </span>
      ),
    },
    ...(several ? [{ key: "account", label: "Account", sort: "account", render: (r: ActivityRow) => <span className="text-muted">{accountLabel(r.account)}</span> }] : []),
    {
      key: "links",
      label: "",
      // On a phone the links go on the row's second line; a row with none adds nothing there.
      mobile: "meta",
      mobileRender: (r) => (r.url || r.pdf ? <ActivityLinks row={r} /> : null),
      render: (r) => <ActivityLinks row={r} />,
    },
  ];

  const fallback = workspace.currency;
  const overdue = filter.state === "overdue";
  return (
    <>
      <div className="grid grid-cols-2 gap-2 px-4 pt-4 lg:grid-cols-4 lg:px-6">
        <Stat label="Collected" value={sumText(totals.collected, fallback)} note="Payments that went through, less refunds" />
        <Stat label="Invoiced" value={sumText(totals.invoiced, fallback)} note="Invoices sent, not counting void ones" />
        <Stat
          label="Outstanding"
          value={sumText(totals.outstanding, fallback)}
          tone={Object.keys(totals.outstanding).length ? "error" : undefined}
          action={
            Object.keys(totals.outstanding).length && !overdue ? (
              <button type="button" onClick={() => set({ state: "overdue", kind: null })} className="font-medium text-accent hover:underline">
                Show overdue
              </button>
            ) : null
          }
        />
        <Stat
          label="Not mapped to a client"
          value={`${totals.unmappedRows.toLocaleString()} ${totals.unmappedRows === 1 ? "row" : "rows"}`}
          tone={totals.unmappedRows ? "warning" : undefined}
          note={totals.unmappedCustomers ? `${totals.unmappedCustomers.toLocaleString()} ${totals.unmappedCustomers === 1 ? "customer" : "customers"}` : "Every customer has a client"}
          action={
            totals.unmappedRows && filter.mapped !== "unmapped" ? (
              <button type="button" onClick={() => set({ mapped: "unmapped" })} className="font-medium text-accent hover:underline">
                Show them
              </button>
            ) : null
          }
        />
      </div>
      <Toolbar>
        <SearchBox placeholder="Search customers, clients, invoices" />
        <FilterSelect param="kind" label="Type" className="w-36" options={[["", "All types"], ["invoice", "Invoices"], ["payment", "Payments"]]} />
        <FilterSelect param="state" label="Status" className="w-40" options={[["", "Any status"], ...activityStates.map((s) => [s, activityStateLabels[s].label] as [string, string])]} />
        <FilterSelect param="mapped" label="Mapping" className="w-44" options={[["", "Mapped or not"], ["mapped", "Mapped to a client"], ["unmapped", "Not mapped"]]} />
        {several ? <FilterSelect param="account" label="Stripe account" className="w-44" options={[["", "Every account"], ...accounts.map((a) => [a.id, a.label] as [string, string])]} /> : null}
        <span className="flex items-center gap-1.5 text-[12.5px] text-muted">
          <Input type="date" value={get("from") ?? ""} max={get("to") ?? undefined} onChange={(e) => set({ from: e.target.value || null })} aria-label="From date" className="h-8 w-36 px-2 text-[13px]" />
          to
          <Input type="date" value={get("to") ?? ""} min={get("from") ?? undefined} onChange={(e) => set({ to: e.target.value || null })} aria-label="To date" className="h-8 w-36 px-2 text-[13px]" />
        </span>
        {filtered ? (
          <Button size="sm" variant="ghost" onClick={() => set({ q: null, kind: null, state: null, mapped: null, account: null, from: null, to: null })}>
            Clear filters
          </Button>
        ) : null}
      </Toolbar>
      <DataTable
        columns={columns}
        rows={paging.rows}
        rowId={activityRowId}
        href={(r) => (r.clients[0] ? `/clients/${r.clients[0].id}` : null)}
        flag={(r) => !!r.customerId && !r.clients.length}
        defaultSort="date"
        paging={{ total: totals.rows, ...paging }}
        empty={
          <EmptyState
            icon={BanknotesIcon}
            title={filtered ? "Nothing matches these filters" : "No invoices or payments yet"}
            description={filtered ? "Try a wider date range or clear the filters." : "They show here after the next Stripe sync. Admins can sync now from the top of the page."}
          />
        }
      />
      {mapping ? <MapCustomerDialog target={mapping} onClose={() => setMapping(null)} /> : null}
    </>
  );
}

/** The invoice page and PDF, or the payment's receipt, in Stripe. */
function ActivityLinks({ row: r }: { row: ActivityRow }) {
  return (
    <span className="flex justify-end gap-3 text-[12.5px]">
      {r.url ? (
        <a href={r.url} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
          {r.kind === "invoice" ? "View" : "Receipt"}
        </a>
      ) : null}
      {r.pdf ? (
        <a href={r.pdf} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
          PDF
        </a>
      ) : null}
    </span>
  );
}

function StateBadge({ row }: { row: ActivityRow }) {
  const s = activityStateLabels[row.state];
  const badge = <StatusBadge tone={s.tone}>{s.label}</StatusBadge>;
  const note = row.state === "failed" && row.failure ? row.failure : (row.state === "unpaid" || row.state === "overdue") && row.dueAt ? `Due ${day(row.dueAt)}` : null;
  return note ? <Tooltip content={note}>{badge}</Tooltip> : badge;
}

/** The clients a row's customer belongs to, or a flag and a way to map it when nobody has it. */
function ClientsCell({ row, canEdit, onMap }: { row: { clients: MappedClient[]; customerId: string | null }; canEdit: boolean; onMap: () => void }) {
  const [main, ...others] = row.clients;
  if (main)
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <Link href={`/clients/${main.id}`} className="truncate font-medium text-primary hover:underline">
          {main.name}
        </Link>
        {others.length ? (
          <Tooltip content={others.map((c) => c.name).join(", ")}>
            <span className="shrink-0 text-[12px] text-muted">+{others.length}</span>
          </Tooltip>
        ) : null}
      </span>
    );
  if (!row.customerId) return <StatusBadge>No customer</StatusBadge>;
  return (
    <span className="inline-flex items-center gap-2">
      <StatusBadge tone="warning" icon={<ExclamationTriangleIcon />}>
        Not mapped
      </StatusBadge>
      {canEdit ? (
        <button type="button" onClick={onMap} className="text-[12.5px] font-medium text-accent hover:underline">
          Map
        </button>
      ) : null}
    </span>
  );
}

function FilterSelect({ param, label, options, className }: { param: string; label: string; options: [string, string][]; className?: string }) {
  const { get, set } = useListParams();
  return (
    <Select value={get(param) ?? ""} onChange={(e) => set({ [param]: e.target.value || null })} aria-label={label} className={clsx(className, "[&_select]:h-8 [&_select]:text-[13px] pointer-coarse:[&_select]:h-10")}>
      {options.map(([value, text]) => (
        <option key={value} value={value}>
          {text}
        </option>
      ))}
    </Select>
  );
}

// ─── Customer mapping ────────────────────────────────────────────────────

const mappingRowId = (r: MappingRow) => `${r.account}:${r.customerId}`;

function MappingTab({ rows: first, total, filter, pageSize, accounts }: { rows: MappingRow[]; total: number; filter: MappingFilter; pageSize: number; accounts: Account[] }) {
  const { canEdit } = useApp();
  const [mapping, setMapping] = useState<MapTarget | null>(null);
  const [pending, start] = useTransition();
  const filterKey = JSON.stringify(filter);
  const fetchPage = useCallback((offset: number, limit: number) => moreStripeCustomers(JSON.parse(filterKey), { offset, limit }), [filterKey]);
  const paging = usePagedRows({ first, total, filterKey, rowId: mappingRowId, pageSize, fetchPage });
  const several = accounts.length > 1;
  const accountLabel = (id: string) => accounts.find((a) => a.id === id)?.label ?? id;

  const unmap = (r: MappingRow, c: MappedClient) => {
    const who = customerTitle({ name: r.name, email: r.email, id: r.customerId });
    const ask = c.byHand
      ? `Unmap ${who} from ${c.name}? Its invoices and payments stop showing on the client.`
      : `${who} matches ${c.name} because ${c.email ?? "its email"} is on one of the client's people. Take it off ${c.name} anyway? It stays off until someone maps it again.`;
    if (!confirm(ask)) return;
    start(async () => {
      const res = await removeStripeCustomer(c.id, r.account, r.customerId);
      if (!res.ok) return void toast.error(res.error);
      toast.success(`${who} is no longer on ${c.name}`);
    });
  };

  const columns: Column<MappingRow>[] = [
    {
      key: "customer",
      label: "Customer",
      sort: "customer",
      className: "min-w-52 max-w-72",
      render: (r) => (
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate font-medium text-primary">{r.name || r.email || r.customerId}</span>
          <span className="truncate text-[12px] text-muted">{[several ? accountLabel(r.account) : null, r.customerId].filter(Boolean).join(" · ")}</span>
        </span>
      ),
    },
    { key: "email", label: "Billing email", sort: "email", mobile: "meta", className: "max-w-64", render: (r) => (r.email ? <span className="truncate text-secondary">{r.email}</span> : <span className="text-faint">No email</span>) },
    {
      key: "client",
      label: "Client",
      sort: "client",
      mobile: "meta",
      className: "max-w-80",
      render: (r) =>
        r.clients.length ? (
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            {r.clients.map((c) => (
              <span key={c.id} className="inline-flex h-6 max-w-full items-center gap-1 rounded-md border border-line bg-surface pr-1 pl-2 text-[12.5px]">
                <Link href={`/clients/${c.id}`} className="truncate font-medium text-primary hover:underline">
                  {c.name}
                </Link>
                <span className="shrink-0 text-[11.5px] text-muted">{c.byHand ? "by hand" : "by email"}</span>
                {canEdit ? (
                  <button type="button" onClick={() => unmap(r, c)} disabled={pending} className="rounded p-0.5 text-faint hover:bg-sunken hover:text-primary" aria-label={`Take ${r.name ?? r.customerId} off ${c.name}`}>
                    <XMarkIcon className="size-3.5" />
                  </button>
                ) : null}
              </span>
            ))}
          </span>
        ) : (
          <StatusBadge tone="warning" icon={<ExclamationTriangleIcon />}>
            Not mapped
          </StatusBadge>
        ),
    },
    { key: "activity", label: "Activity", sort: "activity", align: "right", mobile: "end", render: (r) => <span className="text-secondary tabular-nums">{r.activity.toLocaleString()}</span> },
    { key: "collected", label: "Collected LTM", sort: "collected", align: "right", render: (r) => <span className="text-secondary tabular-nums">{money(r.collectedYear, r.currency)}</span> },
    { key: "last", label: "Last activity", sort: "last", render: (r) => (r.lastAt ? <span className="text-secondary tabular-nums">{day(r.lastAt)}</span> : <span className="text-faint">—</span>) },
    ...(canEdit
      ? [
          {
            key: "map",
            label: "",
            mobile: "meta" as const,
            mobileRender: (r: MappingRow) => (
              <button type="button" onClick={() => setMapping({ account: r.account, customerId: r.customerId, name: r.name, email: r.email })} className="font-medium text-accent hover:underline">
                {r.clients.length ? "Add a client" : "Map to client"}
              </button>
            ),
            render: (r: MappingRow) => (
              <span className="flex justify-end">
                <Button size="sm" variant={r.clients.length ? "ghost" : "outline"} onClick={() => setMapping({ account: r.account, customerId: r.customerId, name: r.name, email: r.email })}>
                  <LinkIcon />
                  {r.clients.length ? "Add a client" : "Map to client"}
                </Button>
              </span>
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      <p className="max-w-3xl px-4 pt-3 text-[13px] text-muted lg:px-6">
        A Stripe customer belongs to a client when its billing email is on one of the client&apos;s people, or anyone at its organization. When it isn&apos;t (a shared billing inbox, an accountant, an old address), map the customer to its client here.
        Its invoices and payments show on the client, and count in its revenue, straight away.
      </p>
      <Toolbar>
        <SearchBox placeholder="Search customers or clients" />
        {/* Not mapped first; "all" is spelled out in the URL because no value means not mapped here. */}
        <FilterTabs
          param="mapped"
          fallback="unmapped"
          options={[
            { value: "unmapped", label: "Not mapped" },
            { value: "by_hand", label: "Mapped by hand" },
            { value: "mapped", label: "Mapped" },
            { value: "all", label: "All" },
          ]}
        />
        {several ? <FilterSelect param="account" label="Stripe account" className="w-44" options={[["", "Every account"], ...accounts.map((a) => [a.id, a.label] as [string, string])]} /> : null}
      </Toolbar>
      <DataTable
        columns={columns}
        rows={paging.rows}
        rowId={mappingRowId}
        href={(r) => (r.clients[0] ? `/clients/${r.clients[0].id}` : null)}
        flag={(r) => !r.clients.length}
        defaultSort="last"
        paging={{ total, ...paging }}
        empty={
          <EmptyState
            icon={LinkIcon}
            title={filter.mapped === "unmapped" && !filter.q ? "Every Stripe customer is mapped" : "No customers match"}
            description={filter.mapped === "unmapped" && !filter.q ? "Each customer's email matches someone at a client, or was mapped by hand." : "Try another search, or show all customers."}
          />
        }
      />
      {mapping ? <MapCustomerDialog target={mapping} onClose={() => setMapping(null)} /> : null}
    </>
  );
}
