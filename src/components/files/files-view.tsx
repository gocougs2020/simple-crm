"use client";

import clsx from "clsx";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type DragEvent } from "react";
import { ArrowUpTrayIcon, ChevronRightIcon, EllipsisHorizontalIcon, FolderPlusIcon, PencilSquareIcon, TrashIcon, ArrowsRightLeftIcon } from "@heroicons/react/20/solid";
import { ChatBubbleOvalLeftEllipsisIcon, FolderIcon, PaperClipIcon } from "@heroicons/react/24/outline";
import { FolderIcon as FolderSolidIcon } from "@heroicons/react/20/solid";
import { createFolder, deleteFolder, moveFiles, updateFolder } from "@/actions/files";
import { useApp } from "@/components/app-context";
import { PageHeader } from "@/components/shell/app-shell";
import { OwnerCell } from "@/components/table/cells";
import { FilterTabs, SearchBox, Toolbar } from "@/components/table/toolbar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import type { FileRow, FileView, FolderRow } from "@/lib/crm/files";
import { folderLabel, folderPath } from "@/lib/folder-tree";
import { formatBytes, formatDay } from "@/lib/format";
import { FileDialog, FileMenu, MoveDialog, PublicBadge, RecordChips } from "./file-actions";
import { FileIcon, useUploader } from "./files-panel";

const DRAG_TYPE = "application/x-crm-files";
type Dragged = { files: string[]; folder?: string };

const viewHref = (view: FileView, folderId?: string | null) => {
  const p = new URLSearchParams();
  if (view !== "general") p.set("view", view);
  if (folderId) p.set("folder", folderId);
  const s = p.toString();
  return s ? `/files?${s}` : "/files";
};

/**
 * The team's files, three ways: general files in folders (a lightweight
 * shared drive), every file on a client, person or organization, and what was
 * posted in the team chat. Files can be dragged onto a folder or a breadcrumb
 * to move them, and dropped from the desktop to upload into the open folder.
 */
export function FilesView({ view, folderId, q, rows, folders, counts }: { view: FileView; folderId: string | null; q: string; rows: FileRow[]; folders: FolderRow[]; counts: Record<FileView, number> }) {
  const { workspace, services, canEdit, isAdmin, viewer } = useApp();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ files: string[]; current: string | null } | null>(null);
  const [folderDialog, setFolderDialog] = useState<{ mode: "new" } | { mode: "rename"; folder: FolderRow } | { mode: "move"; folder: FolderRow } | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [pageDrop, setPageDrop] = useState(false);
  const [, start] = useTransition();
  const folder = folderId ? folders.find((f) => f.id === folderId) : undefined;
  const { uploads, run } = useUploader({ folderId: view === "general" ? (folder?.id ?? null) : null });
  const general = view === "general";
  const browsing = general && !q;
  const subfolders = browsing ? folders.filter((f) => f.parentId === (folder?.id ?? null)) : [];
  const crumbs = folderPath(folders, folder?.id);
  const ids = rows.map((r) => r.id);
  const allOn = ids.length > 0 && ids.every((id) => selected.has(id));
  const tz = workspace.timezone;

  const move = async (fileIds: string[], to: string | null) => {
    const r = await moveFiles(fileIds, to);
    if (!r.ok) return void toast.error(r.error);
    toast.success(`${fileIds.length === 1 ? "File" : `${fileIds.length} files`} moved to ${folderLabel(folders, to)}`);
    setSelected(new Set());
  };
  const moveFolder = async (id: string, to: string | null) => {
    if (id === to) return;
    const r = await updateFolder(id, { parentId: to });
    if (!r.ok) return void toast.error(r.error);
    toast.success(`Folder moved to ${folderLabel(folders, to)}`);
  };

  // Dragging files (or a folder) onto a folder or a breadcrumb moves them there.
  const dragStart = (e: DragEvent, d: Dragged) => {
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(d));
    e.dataTransfer.effectAllowed = "move";
  };
  const dropTarget = (target: string | null) =>
    canEdit
      ? {
          onDragOver: (e: DragEvent) => {
            if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
            e.preventDefault();
            e.stopPropagation();
            setDropOn(target ?? "top");
          },
          onDragLeave: (e: DragEvent) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropOn(null),
          onDrop: (e: DragEvent) => {
            const raw = e.dataTransfer.getData(DRAG_TYPE);
            setDropOn(null);
            if (!raw) return;
            e.preventDefault();
            e.stopPropagation();
            const d = JSON.parse(raw) as Dragged;
            start(async () => {
              if (d.folder) await moveFolder(d.folder, target);
              else if (d.files.length) await move(d.files, target);
            });
          },
        }
      : {};
  const dragFiles = (id: string): Dragged => ({ files: selected.has(id) ? [...selected] : [id] });

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const emptyText =
    view === "records"
      ? { icon: PaperClipIcon, title: q ? "No files match" : "No files on records yet", description: q ? "Try another name." : "Files uploaded on a client, person or organization show here, and so do general files you attach to one." }
      : view === "chat"
        ? { icon: ChatBubbleOvalLeftEllipsisIcon, title: q ? "No files match" : "Nothing posted in chat yet", description: q ? "Try another name." : "Files your team attaches to chat messages show here." }
        : { icon: FolderIcon, title: q ? "No files match" : folder ? "This folder is empty" : "No general files yet", description: q ? "Try another name." : canEdit ? "Upload files or drop them here, or make a folder to keep things in order." : "Files your team uploads here show up for everyone." };

  return (
    <div
      className={clsx("min-h-[calc(100dvh-3rem)]", pageDrop && "bg-accent-soft/40")}
      onDragOver={(e) => {
        if (!general || !canEdit || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setPageDrop(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setPageDrop(false)}
      onDrop={(e) => {
        setPageDrop(false);
        if (!general || !canEdit || !e.dataTransfer.files.length) return;
        e.preventDefault();
        run(e.dataTransfer.files);
      }}
    >
      <PageHeader title="Files" count={counts[view]} sub={!services.blob ? <p className="mt-0.5 text-[12px] text-muted">Stored on this computer for local development. Connect Vercel Blob for production.</p> : null}>
        {general && canEdit ? (
          <>
            <input ref={input} type="file" multiple hidden onChange={(e) => e.target.files && run(e.target.files).then(() => (e.target.value = ""))} />
            <Button onClick={() => setFolderDialog({ mode: "new" })}>
              <FolderPlusIcon />
              New folder
            </Button>
            <Button variant="primary" onClick={() => input.current?.click()} loading={uploads.length > 0}>
              <ArrowUpTrayIcon />
              Upload{folder ? " here" : ""}
            </Button>
          </>
        ) : null}
      </PageHeader>
      <Toolbar>
        <FilterTabs
          param="view"
          fallback="general"
          options={[
            { value: "general", label: <>General files {counts.general ? <span className="ml-1 text-faint tabular-nums">{counts.general}</span> : null}</> },
            { value: "records", label: <>On records {counts.records ? <span className="ml-1 text-faint tabular-nums">{counts.records}</span> : null}</> },
            { value: "chat", label: <>From chat {counts.chat ? <span className="ml-1 text-faint tabular-nums">{counts.chat}</span> : null}</> },
          ]}
        />
        <SearchBox placeholder={general ? "Search every folder" : "Search file names"} />
      </Toolbar>

      {general && !q ? (
        <nav aria-label="Folders" className="flex flex-wrap items-center gap-0.5 px-4 pb-2 text-[13.5px] lg:px-6">
          <Link href={viewHref("general")} {...dropTarget(null)} className={clsx("rounded-md px-1.5 py-0.5 font-medium hover:bg-sunken", folder ? "text-muted hover:text-primary" : "text-primary", dropOn === "top" && "bg-accent-soft ring-2 ring-accent")}>
            All files
          </Link>
          {crumbs.map((c) => (
            <span key={c.id} className="flex items-center gap-0.5">
              <ChevronRightIcon className="size-4 text-faint" aria-hidden />
              <Link
                href={viewHref("general", c.id)}
                {...dropTarget(c.id)}
                aria-current={c.id === folder?.id ? "page" : undefined}
                className={clsx("max-w-56 truncate rounded-md px-1.5 py-0.5 font-medium hover:bg-sunken", c.id === folder?.id ? "text-primary" : "text-muted hover:text-primary", dropOn === c.id && "bg-accent-soft ring-2 ring-accent")}
              >
                {c.name}
              </Link>
            </span>
          ))}
          {canEdit && rows.length + subfolders.length > 0 ? <span className="ml-2 hidden text-fine sm:inline">Drag files onto a folder to move them.</span> : null}
        </nav>
      ) : null}

      {selected.size && canEdit ? (
        <div className="sticky top-12 z-20 mx-4 mb-2 flex animate-pop-in items-center gap-3 rounded-lg border border-line bg-primary px-3 py-2 text-[13px] text-white shadow-md lg:top-2 lg:mx-6">
          <span className="font-medium tabular-nums">{selected.size} selected</span>
          <button type="button" className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-2 py-1 font-medium hover:bg-white/20" onClick={() => setMoving({ files: [...selected], current: folder?.id ?? null })}>
            <ArrowsRightLeftIcon className="size-4" />
            Move to folder
          </button>
          <span className="flex-1" />
          <button type="button" onClick={() => setSelected(new Set())} className="text-white/70 hover:text-white">
            Clear
          </button>
        </div>
      ) : null}

      <div className="px-4 pb-6 lg:px-6">
        {uploads.length ? (
          <ul className="mb-2 rounded-lg border border-line bg-surface px-3 py-1">
            {uploads.map((u) => (
              <li key={u.name} className="flex items-center gap-2 py-1.5 text-[13px]">
                <span className="min-w-0 flex-1 truncate text-secondary">Uploading {u.name}</span>
                <span className="w-24 overflow-hidden rounded-full bg-sunken">
                  <span className="block h-1.5 rounded-full bg-accent transition-[width]" style={{ width: `${Math.max(u.pct, 4)}%` }} />
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {!rows.length && !subfolders.length ? (
          <EmptyState {...emptyText} />
        ) : (
          <div className="table-container">
            <table className="w-full border-collapse text-left text-[13.5px]">
              <thead className="sticky top-0 z-10 bg-surface shadow-[0_1px_0_var(--border)]">
                <tr>
                  {canEdit ? (
                    <th className="w-11 p-0">
                      <label className="flex h-10 cursor-pointer items-center justify-center px-3">
                        <input
                          type="checkbox"
                          className="size-[18px] cursor-pointer accent-[var(--accent)]"
                          checked={allOn}
                          disabled={!ids.length}
                          ref={(el) => {
                            if (el) el.indeterminate = selected.size > 0 && !allOn;
                          }}
                          onChange={() => setSelected(allOn ? new Set() : new Set(ids))}
                          aria-label="Select all files"
                        />
                      </label>
                    </th>
                  ) : null}
                  <th scope="col" className="h-10 min-w-64 px-3 text-table-header">
                    Name
                  </th>
                  <th scope="col" className="h-10 px-3 text-table-header">
                    {q && general ? "Folder" : "Attached to"}
                  </th>
                  <th scope="col" className="h-10 px-3 text-right text-table-header">
                    Size
                  </th>
                  <th scope="col" className="hidden h-10 px-3 text-table-header md:table-cell">
                    {view === "chat" ? "Posted by" : "Uploaded by"}
                  </th>
                  <th scope="col" className="hidden h-10 px-3 text-table-header sm:table-cell">
                    Added
                  </th>
                  <th scope="col" className="h-10 w-10 px-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {subfolders.map((f) => (
                  <tr
                    key={f.id}
                    draggable={canEdit}
                    onDragStart={(e) => dragStart(e, { files: [], folder: f.id })}
                    {...dropTarget(f.id)}
                    onClick={(e) => !(e.target as HTMLElement).closest("a,button,input,label") && router.push(viewHref("general", f.id))}
                    className={clsx("table-row-link border-t border-line first:border-t-0", dropOn === f.id && "bg-accent-soft outline-2 -outline-offset-2 outline-accent")}
                  >
                    {canEdit ? <td className="w-11 p-0" /> : null}
                    <td className="h-11 px-3 py-1.5">
                      <Link href={viewHref("general", f.id)} className="flex items-center gap-2 font-medium text-primary hover:underline">
                        <FolderSolidIcon className="size-4 shrink-0 text-accent" aria-hidden />
                        <span className="truncate">{f.name}</span>
                      </Link>
                    </td>
                    <td className="h-11 px-3 py-1.5 text-faint">Folder</td>
                    <td className="h-11 px-3 py-1.5 text-right whitespace-nowrap text-muted tabular-nums">
                      {f.files} {f.files === 1 ? "file" : "files"}
                    </td>
                    <td className="hidden h-11 px-3 py-1.5 md:table-cell">
                      <OwnerCell id={f.createdBy} />
                    </td>
                    <td className="hidden h-11 px-3 py-1.5 sm:table-cell" />
                    <td className="h-11 px-3 py-1.5 text-right">
                      {canEdit ? (
                        <Menu>
                          <MenuTrigger asChild>
                            <button type="button" className="rounded p-1 text-faint hover:bg-sunken hover:text-primary" aria-label={`Actions for the ${f.name} folder`}>
                              <EllipsisHorizontalIcon className="size-4" />
                            </button>
                          </MenuTrigger>
                          <MenuContent>
                            <MenuItem icon={<PencilSquareIcon />} onSelect={() => setFolderDialog({ mode: "rename", folder: f })}>
                              Rename
                            </MenuItem>
                            <MenuItem icon={<ArrowsRightLeftIcon />} onSelect={() => setFolderDialog({ mode: "move", folder: f })}>
                              Move
                            </MenuItem>
                            {!f.createdBy || f.createdBy === viewer.id || isAdmin ? (
                              <>
                                <MenuSeparator />
                                <MenuItem
                                  destructive
                                  icon={<TrashIcon />}
                                  onSelect={async () => {
                                    if (!confirm(`Delete the ${f.name} folder? What's in it moves up to ${folderLabel(folders, f.parentId)}; no files are removed.`)) return;
                                    const r = await deleteFolder(f.id);
                                    if (!r.ok) toast.error(r.error);
                                    else toast.success(`${f.name} deleted. What was in it is in ${folderLabel(folders, f.parentId)}.`);
                                  }}
                                >
                                  Delete folder
                                </MenuItem>
                              </>
                            ) : null}
                          </MenuContent>
                        </Menu>
                      ) : null}
                    </td>
                  </tr>
                ))}
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    draggable={canEdit}
                    onDragStart={(e) => dragStart(e, dragFiles(r.id))}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest("a,button,input,label,[role=menu]")) return;
                      window.open(`/api/files/${r.id}`, "_blank", "noopener");
                    }}
                    className={clsx("table-row-link border-t border-line first:border-t-0", selected.has(r.id) && "bg-accent-soft")}
                  >
                    {canEdit ? (
                      <td className="w-11 p-0">
                        <label className="flex h-11 cursor-pointer items-center justify-center px-3">
                          <input type="checkbox" className="size-[18px] cursor-pointer accent-[var(--accent)]" checked={selected.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.name}`} />
                        </label>
                      </td>
                    ) : null}
                    <td className="h-11 max-w-0 px-3 py-1.5">
                      <span className="flex min-w-0 items-center gap-2">
                        <FileIcon type={r.contentType} />
                        <a href={`/api/files/${r.id}`} target="_blank" rel="noopener" className="truncate font-medium text-primary hover:underline">
                          {r.name}
                        </a>
                        {r.publicToken ? <PublicBadge className="shrink-0" /> : null}
                      </span>
                    </td>
                    <td className="h-11 max-w-72 px-3 py-1.5 text-[13px]">
                      {q && general ? (
                        r.folderId ? (
                          <Link href={viewHref("general", r.folderId)} className="inline-flex max-w-full items-center gap-1 text-secondary hover:text-primary hover:underline">
                            <FolderSolidIcon className="size-3.5 shrink-0 text-faint" aria-hidden />
                            <span className="truncate">{folderLabel(folders, r.folderId)}</span>
                          </Link>
                        ) : (
                          <span className="text-faint">Top level</span>
                        )
                      ) : (
                        <RecordChips
                          records={r.records}
                          none={
                            r.chatMessageId ? (
                              <Link href={`/chat#m-${r.chatMessageId}`} className="inline-flex items-center gap-1 text-secondary hover:text-primary hover:underline">
                                <ChatBubbleOvalLeftEllipsisIcon className="size-3.5 text-faint" aria-hidden />
                                Team chat
                              </Link>
                            ) : undefined
                          }
                        />
                      )}
                    </td>
                    <td className="h-11 px-3 py-1.5 text-right whitespace-nowrap text-muted tabular-nums">{formatBytes(r.size)}</td>
                    <td className="hidden h-11 px-3 py-1.5 md:table-cell">
                      <OwnerCell id={r.uploadedBy} />
                    </td>
                    <td className="hidden h-11 px-3 py-1.5 whitespace-nowrap text-muted sm:table-cell" suppressHydrationWarning>
                      {formatDay(r.createdAt, tz)}
                    </td>
                    <td className="h-11 px-3 py-1.5 text-right">
                      <FileMenu file={r} onEdit={() => setEditing(r.id)} onMove={() => setMoving({ files: [r.id], current: r.folderId })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length >= 500 ? <p className="mt-2 text-fine">Showing the first 500. Search to narrow it down.</p> : null}
        {view === "records" && rows.length ? <p className="mt-2 text-fine">Upload on a record&apos;s page to attach a file there, or attach any file to more records with Edit.</p> : null}
      </div>

      {editing ? <FileDialog fileId={editing} onClose={() => setEditing(null)} /> : null}
      {moving ? (
        <MoveDialog
          folders={folders}
          current={moving.current}
          count={moving.files.length}
          onClose={() => setMoving(null)}
          onMove={async (to) => {
            await move(moving.files, to);
            setMoving(null);
          }}
        />
      ) : null}
      {folderDialog?.mode === "move" ? (
        <MoveDialog
          folders={folders.filter((f) => f.id !== folderDialog.folder.id && !folderPath(folders, f.id).some((p) => p.id === folderDialog.folder.id))}
          current={folderDialog.folder.parentId}
          count={1}
          onClose={() => setFolderDialog(null)}
          onMove={async (to) => {
            await moveFolder(folderDialog.folder.id, to);
            setFolderDialog(null);
          }}
        />
      ) : folderDialog ? (
        <FolderNameDialog
          folder={folderDialog.mode === "rename" ? folderDialog.folder : undefined}
          where={folderLabel(folders, folder?.id)}
          onClose={() => setFolderDialog(null)}
          onSave={async (name) => {
            if (folderDialog.mode === "rename") {
              const r = await updateFolder(folderDialog.folder.id, { name });
              if (!r.ok) return void toast.error(r.error);
              toast.success("Folder renamed");
            } else {
              const r = await createFolder({ name, parentId: folder?.id ?? null });
              if (!r.ok) return void toast.error(r.error);
              toast.success(`${name} created`);
            }
            setFolderDialog(null);
          }}
        />
      ) : null}
    </div>
  );
}

function FolderNameDialog({ folder, where, onSave, onClose }: { folder?: FolderRow; where: string; onSave: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(folder?.name ?? "");
  const [pending, start] = useTransition();
  const submit = () => name.trim() && start(() => onSave(name.trim()));
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={folder ? "Rename folder" : "New folder"}
      description={folder ? undefined : `In ${where}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} disabled={!name.trim()} onClick={submit}>
            {folder ? "Save" : "Create folder"}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Name">{(p) => <Input {...p} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Contracts" />}</Field>
      </form>
    </Dialog>
  );
}
