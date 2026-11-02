"use client";

import { PlusIcon } from "@heroicons/react/20/solid";
import { BuildingOffice2Icon } from "@heroicons/react/24/outline";
import { assignOwner, setArchived } from "@/actions/records";
import { useApp } from "@/components/app-context";
import { CategoryBadge } from "@/components/clients/client-controls";
import { BulkButton } from "@/components/clients/clients-view";
import { formatCustomValue } from "@/components/records/custom-field-input";
import { PageHeader } from "@/components/shell/app-shell";
import { openCreate } from "@/components/shell/create-store";
import { AgoCell, NextActivityCell, OwnerCell } from "@/components/table/cells";
import { DataTable, type Column } from "@/components/table/data-table";
import { OwnerFilter, SearchBox, Toolbar } from "@/components/table/toolbar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toast";
import type { listOrganizations } from "@/lib/crm/records";

type Row = Awaited<ReturnType<typeof listOrganizations>>[number];

export function OrganizationsView({ rows, filtered }: { rows: Row[]; filtered: boolean }) {
  const { viewer, customFields, money, team, member } = useApp();
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
        </span>
      ),
    },
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
      <PageHeader title="Organizations" count={rows.length}>
        <Button variant="primary" onClick={() => openCreate({ kind: "organization" })}>
          <PlusIcon />
          Organization
        </Button>
      </PageHeader>
      <Toolbar>
        <SearchBox placeholder="Search name, website, industry" />
        <OwnerFilter />
      </Toolbar>
      <DataTable
        columns={columns}
        rows={rows}
        rowId={(r) => r.organization.id}
        href={(r) => `/organizations/${r.organization.id}`}
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
        bulk={(ids, clear) => (
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
          </>
        )}
      />
    </>
  );
}
