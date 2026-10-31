"use client";

import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ArrowDownTrayIcon, ArrowUpTrayIcon, DocumentIcon, PhotoIcon, TrashIcon } from "@heroicons/react/20/solid";
import { deleteFile } from "@/actions/files";
import { useApp } from "@/components/app-context";
import { SideCard } from "@/components/records/inline-field";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { formatBytes, formatDay } from "@/lib/format";
import { uploadFile, type FileLinks } from "./upload";

export type FileRow = { id: string; name: string; size: number; contentType: string; uploadedBy: string; createdAt: Date };

/** Drop zone plus upload progress, shared by record pages and the Files page. */
export function useUploader(links: FileLinks) {
  const { services } = useApp();
  const router = useRouter();
  const [uploads, setUploads] = useState<{ name: string; pct: number }[]>([]);
  const run = async (list: FileList | File[]) => {
    const files = [...list];
    if (!files.length) return;
    setUploads(files.map((f) => ({ name: f.name, pct: 0 })));
    let ok = 0;
    for (const [i, f] of files.entries()) {
      try {
        await uploadFile(f, links, services.blob, (pct) => setUploads((u) => u.map((x, j) => (j === i ? { ...x, pct } : x))));
        ok++;
      } catch (err) {
        toast.error((err as Error).message);
      }
    }
    setUploads([]);
    if (ok) {
      toast.success(ok === 1 ? `${files.find((_, i) => i === 0)?.name} uploaded` : `${ok} files uploaded`);
      router.refresh();
    }
  };
  return { uploads, run };
}

export function FileIcon({ type, className }: { type: string; className?: string }) {
  const Icon = type.startsWith("image/") ? PhotoIcon : DocumentIcon;
  return <Icon className={clsx("size-4 shrink-0 text-faint", className)} aria-hidden />;
}

export function FilesPanel({ files, links }: { files: FileRow[]; links: FileLinks }) {
  const { workspace, member, viewer, isAdmin } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const { uploads, run } = useUploader(links);
  return (
    <SideCard
      title={
        <>
          Files <span className="font-medium text-muted tabular-nums">{files.length || ""}</span>
        </>
      }
      action={
        <Button size="sm" variant="ghost" onClick={() => input.current?.click()} className="-mr-2">
          <ArrowUpTrayIcon />
          Upload
        </Button>
      }
    >
      <input ref={input} type="file" multiple hidden onChange={(e) => e.target.files && run(e.target.files).then(() => (e.target.value = ""))} />
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          run(e.dataTransfer.files);
        }}
        className={clsx("rounded-lg transition-colors", over && "bg-accent-soft ring-2 ring-accent ring-dashed")}
      >
        {uploads.map((u) => (
          <div key={u.name} className="flex items-center gap-2 py-1.5 text-[13px]">
            <DocumentIcon className="size-4 text-faint" />
            <span className="min-w-0 flex-1 truncate text-secondary">{u.name}</span>
            <span className="w-16 overflow-hidden rounded-full bg-sunken">
              <span className="block h-1.5 rounded-full bg-accent transition-[width]" style={{ width: `${Math.max(u.pct, 4)}%` }} />
            </span>
          </div>
        ))}
        {files.length ? (
          <ul className="-mx-2">
            {files.map((f) => (
              <li key={f.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sunken">
                <FileIcon type={f.contentType} />
                <a href={`/api/files/${f.id}`} target="_blank" rel="noopener" className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-primary">{f.name}</span>
                  <span className="block text-[11.5px] text-muted">
                    {formatBytes(f.size)} · {member(f.uploadedBy)?.name ?? "Someone"} · {formatDay(f.createdAt, workspace.timezone)}
                  </span>
                </a>
                <a href={`/api/files/${f.id}?download`} className="rounded p-1 text-faint opacity-0 group-hover:opacity-100 hover:text-primary focus:opacity-100" aria-label={`Download ${f.name}`}>
                  <ArrowDownTrayIcon className="size-4" />
                </a>
                {f.uploadedBy === viewer.id || isAdmin ? (
                  <button
                    type="button"
                    onClick={async () => {
                      if (!confirm(`Remove ${f.name}?`)) return;
                      const r = await deleteFile(f.id);
                      if (!r.ok) toast.error(r.error);
                    }}
                    className="rounded p-1 text-faint opacity-0 group-hover:opacity-100 hover:text-error focus:opacity-100"
                    aria-label={`Remove ${f.name}`}
                  >
                    <TrashIcon className="size-4" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : !uploads.length ? (
          <button type="button" onClick={() => input.current?.click()} className="w-full rounded-lg border border-dashed border-line py-4 text-[12.5px] text-muted hover:border-line-strong hover:text-secondary">
            Drop files here or click to upload
          </button>
        ) : null}
      </div>
    </SideCard>
  );
}
