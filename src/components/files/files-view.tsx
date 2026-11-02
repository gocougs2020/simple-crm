"use client";

import Link from "next/link";
import { useRef } from "react";
import { ArrowDownTrayIcon, ArrowUpTrayIcon, TrashIcon } from "@heroicons/react/20/solid";
import { FolderIcon } from "@heroicons/react/24/outline";
import { deleteFile } from "@/actions/files";
import { useApp } from "@/components/app-context";
import { PageHeader } from "@/components/shell/app-shell";
import { OwnerCell } from "@/components/table/cells";
import { DataTable, type Column } from "@/components/table/data-table";
import { SearchBox, Toolbar } from "@/components/table/toolbar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/components/ui/toast";
import type { listFiles } from "@/lib/crm/records";
import { formatBytes, formatDay } from "@/lib/format";
import { FileIcon, useUploader } from "./files-panel";

type Row = Awaited<ReturnType<typeof listFiles>>[number];

/** Every file across the CRM. Upload here for general files, or from a record to attach them to it. */
export function FilesView({ rows }: { rows: Row[] }) {
  const { workspace, viewer, isAdmin, services } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const { uploads, run } = useUploader({});
  const columns: Column<Row>[] = [
    {
      key: "name",
      label: "Name",
      className: "min-w-64",
      render: (r) => (
        <a href={`/api/files/${r.file.id}`} target="_blank" rel="noopener" className="flex items-center gap-2 font-medium text-primary hover:underline">
          <FileIcon type={r.file.contentType} />
          <span className="truncate">{r.file.name}</span>
        </a>
      ),
    },
    {
      key: "on",
      label: "Attached to",
      render: (r) => {
        const links = [
          r.file.clientId && r.clientName ? { href: `/clients/${r.file.clientId}`, label: r.clientName } : null,
          r.file.personId && r.personName ? { href: `/people/${r.file.personId}`, label: r.personName } : null,
          r.file.organizationId && r.organizationName ? { href: `/organizations/${r.file.organizationId}`, label: r.organizationName } : null,
        ].filter((x): x is { href: string; label: string } => !!x);
        return links.length ? (
          <span className="flex flex-wrap gap-x-2">
            {links.map((l) => (
              <Link key={l.href} href={l.href} className="text-secondary hover:underline">
                {l.label}
              </Link>
            ))}
          </span>
        ) : (
          <span className="text-faint">General</span>
        );
      },
    },
    { key: "size", label: "Size", align: "right", render: (r) => <span className="text-muted tabular-nums">{formatBytes(r.file.size)}</span> },
    { key: "by", label: "Uploaded by", render: (r) => <OwnerCell id={r.file.uploadedBy} /> },
    { key: "date", label: "Added", render: (r) => <span className="whitespace-nowrap text-muted">{formatDay(r.file.createdAt, workspace.timezone)}</span> },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (r) => (
        <span className="inline-flex gap-1">
          <a href={`/api/files/${r.file.id}?download`} className="rounded p-1 text-faint hover:text-primary" aria-label={`Download ${r.file.name}`}>
            <ArrowDownTrayIcon className="size-4" />
          </a>
          {r.file.uploadedBy === viewer.id || isAdmin ? (
            <button
              type="button"
              className="rounded p-1 text-faint hover:text-error"
              aria-label={`Remove ${r.file.name}`}
              onClick={async () => {
                if (!confirm(`Remove ${r.file.name}?`)) return;
                const res = await deleteFile(r.file.id);
                if (!res.ok) toast.error(res.error);
                else toast.success(`${r.file.name} removed`);
              }}
            >
              <TrashIcon className="size-4" />
            </button>
          ) : null}
        </span>
      ),
    },
  ];
  return (
    <>
      <PageHeader title="Files" count={rows.length} sub={!services.blob ? <p className="mt-0.5 text-[12px] text-muted">Stored on this computer for local development. Connect Vercel Blob for production.</p> : null}>
        <input ref={input} type="file" multiple hidden onChange={(e) => e.target.files && run(e.target.files).then(() => (e.target.value = ""))} />
        <Button variant="primary" onClick={() => input.current?.click()} loading={uploads.length > 0}>
          <ArrowUpTrayIcon />
          Upload
        </Button>
      </PageHeader>
      <Toolbar>
        <SearchBox placeholder="Search file names" />
      </Toolbar>
      <DataTable
        columns={columns}
        rows={rows}
        rowId={(r) => r.file.id}
        href={(r) => `/api/files/${r.file.id}`}
        empty={<EmptyState icon={FolderIcon} title="No files yet" description="Upload proposals, contracts and anything else your team needs. Files uploaded on a record are attached to it." />}
      />
    </>
  );
}
