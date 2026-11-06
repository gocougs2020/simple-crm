"use client";

import clsx from "clsx";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ArrowDownTrayIcon, ArrowUpTrayIcon, DocumentIcon, EnvelopeIcon, PhotoIcon, TrashIcon } from "@heroicons/react/20/solid";
import { deleteFile } from "@/actions/files";
import { useApp } from "@/components/app-context";
import { SideCard } from "@/components/records/inline-field";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { activityLabels } from "@/lib/constants";
import type { EmailFile, RecordFile } from "@/lib/crm/activities";
import { formatBytes, formatDay, senderName } from "@/lib/format";
import { uploadFile, type FileLinks } from "./upload";

/** Upload progress, shared by record timelines and the Files page. */
export function useUploader(links: FileLinks) {
  const { services } = useApp();
  const router = useRouter();
  const [uploads, setUploads] = useState<{ name: string; pct: number }[]>([]);
  /** `extra` adds links for this upload only, like the activity a file is attached to. */
  const run = async (list: FileList | File[], extra?: FileLinks) => {
    const files = [...list];
    if (!files.length) return;
    setUploads(files.map((f) => ({ name: f.name, pct: 0 })));
    let ok = 0;
    for (const [i, f] of files.entries()) {
      try {
        await uploadFile(f, { ...links, ...extra }, services.blob, (pct) => setUploads((u) => u.map((x, j) => (j === i ? { ...x, pct } : x))));
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

const SHOWN = 8;

/**
 * Every file on a record in one list, newest first: files added on their own,
 * files attached to a note, call or other activity, and attachments on inbox
 * mail (which open with their conversation). Upload here (button or drop) to
 * add a file to the record itself; attach one to a note or call from the
 * composer.
 */
export function FilesCard({ files, emailFiles, links }: { files: RecordFile[]; emailFiles: EmailFile[]; links: FileLinks }) {
  const { workspace, member, viewer, isAdmin } = useApp();
  const tz = workspace.timezone;
  const [all, setAll] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const { uploads, run } = useUploader(links);
  const rows = [...files.map((f) => ({ kind: "file" as const, at: new Date(f.createdAt).getTime(), f })), ...emailFiles.map((e) => ({ kind: "email" as const, at: new Date(e.at).getTime(), e }))].sort((a, b) => b.at - a.at);
  const shown = all ? rows : rows.slice(0, SHOWN);
  return (
    <SideCard
      title={
        <>
          Files <span className="font-medium text-muted tabular-nums">{rows.length || ""}</span>
        </>
      }
      action={
        <Button size="sm" variant="ghost" className="-mr-2" onClick={() => input.current?.click()}>
          <ArrowUpTrayIcon />
          Upload
        </Button>
      }
    >
      <input ref={input} type="file" multiple hidden onChange={(e) => e.target.files && run(e.target.files).then(() => (e.target.value = ""))} />
      <div
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(false)}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setOver(false);
          run(e.dataTransfer.files);
        }}
        className={clsx("-mx-2 rounded-lg px-2", over && "bg-accent-soft ring-2 ring-accent ring-dashed")}
      >
        {uploads.map((u) => (
          <div key={u.name} className="flex items-center gap-2 py-1.5 text-[13px]">
            <DocumentIcon className="size-4 text-faint" aria-hidden />
            <span className="min-w-0 flex-1 truncate text-secondary">{u.name}</span>
            <span className="w-16 overflow-hidden rounded-full bg-sunken">
              <span className="block h-1.5 rounded-full bg-accent transition-[width]" style={{ width: `${Math.max(u.pct, 4)}%` }} />
            </span>
          </div>
        ))}
        {rows.length ? (
          <ul className="-mx-2">
            {shown.map((r) =>
              r.kind === "file" ? (
                <li key={r.f.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sunken">
                  <FileIcon type={r.f.contentType} />
                  <a href={`/api/files/${r.f.id}`} target="_blank" rel="noopener" className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-primary">{r.f.name}</span>
                    <span className="block truncate text-[11.5px] text-muted" suppressHydrationWarning>
                      {r.f.activityType ? `In a ${activityLabels[r.f.activityType].toLowerCase()} · ` : ""}
                      {formatBytes(r.f.size)} · {member(r.f.uploadedBy)?.name ?? "Someone"} · {formatDay(r.f.createdAt, tz)}
                    </span>
                  </a>
                  <a href={`/api/files/${r.f.id}?download`} className="rounded p-1 text-faint opacity-0 group-hover:opacity-100 hover:text-primary focus:opacity-100" aria-label={`Download ${r.f.name}`}>
                    <ArrowDownTrayIcon className="size-4" />
                  </a>
                  {r.f.uploadedBy === viewer.id || isAdmin ? (
                    <button
                      type="button"
                      onClick={async () => {
                        if (!confirm(`Remove ${r.f.name}?`)) return;
                        const res = await deleteFile(r.f.id);
                        if (!res.ok) toast.error(res.error);
                      }}
                      className="rounded p-1 text-faint opacity-0 group-hover:opacity-100 hover:text-error focus:opacity-100"
                      aria-label={`Remove ${r.f.name}`}
                    >
                      <TrashIcon className="size-4" />
                    </button>
                  ) : null}
                </li>
              ) : (
                <li key={r.e.key}>
                  <Link href={`/email?t=${r.e.threadId}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-sunken">
                    <EnvelopeIcon className="size-4 shrink-0 text-faint" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-primary">{r.e.name}</span>
                      <span className="block truncate text-[11.5px] text-muted" suppressHydrationWarning>
                        From an email{r.e.size ? ` · ${formatBytes(r.e.size)}` : ""} · {senderName(r.e.from)} · {formatDay(r.e.at, tz)}
                      </span>
                    </span>
                  </Link>
                </li>
              ),
            )}
          </ul>
        ) : !uploads.length ? (
          <p className="py-1 text-[12.5px] text-muted">No files yet. Upload one or drop it here, or attach one to a note or call.</p>
        ) : null}
      </div>
      {rows.length > SHOWN ? (
        <button type="button" className="mt-1 text-[12.5px] font-medium text-muted hover:text-primary" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      ) : null}
    </SideCard>
  );
}
