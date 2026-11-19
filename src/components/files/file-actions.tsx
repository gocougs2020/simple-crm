"use client";

import clsx from "clsx";
import Link from "next/link";
import { useEffect, useState, useTransition, type ReactNode } from "react";
import {
  ArrowDownTrayIcon,
  ArrowTopRightOnSquareIcon,
  BriefcaseIcon,
  BuildingOffice2Icon,
  EllipsisHorizontalIcon,
  FolderIcon,
  GlobeAltIcon,
  LinkIcon,
  LockClosedIcon,
  PencilSquareIcon,
  TrashIcon,
  UserIcon,
  XMarkIcon,
} from "@heroicons/react/20/solid";
import { deleteFile, getFileDetails, setFileRecords, setFileVisibility, updateFile } from "@/actions/files";
import { useApp } from "@/components/app-context";
import { RecordPicker } from "@/components/records/record-picker";
import { Button, Spinner } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import type { EntityType } from "@/lib/constants";
import type { FileRecord, FolderRow } from "@/lib/crm/files";
import { folderTree } from "@/lib/folder-tree";
import { formatBytes } from "@/lib/format";

/** Where a public file opens for people outside the team. */
export const publicFileUrl = (token: string) => `${window.location.origin}/share/${token}`;
/** Where a teammate opens it (they sign in first). */
export const internalFileUrl = (id: string) => `${window.location.origin}/api/files/${id}`;

export async function copyText(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    toast.error("Couldn't copy. Select the link and copy it yourself.");
  }
}

const recordPath = { client: "clients", person: "people", organization: "organizations" } as const;
const recordIcon = { client: BriefcaseIcon, person: UserIcon, organization: BuildingOffice2Icon } as const;
const recordWord = { client: "Client", person: "Person", organization: "Organization" } as const;

/** The records a file is on, as links. */
export function RecordChips({ records, max = 3, none }: { records: FileRecord[]; max?: number; /** Shown when it's on no record. */ none?: ReactNode }) {
  if (!records.length) return <>{none ?? <span className="text-faint">General</span>}</>;
  const shown = records.slice(0, max);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
      {shown.map((r) => {
        const Icon = recordIcon[r.entity];
        return (
          <Link key={`${r.entity}:${r.id}`} href={`/${recordPath[r.entity]}/${r.id}`} className="inline-flex max-w-48 items-center gap-1 text-secondary hover:text-primary hover:underline" title={`${recordWord[r.entity]}: ${r.name}`}>
            <Icon className="size-3.5 shrink-0 text-faint" aria-hidden />
            <span className="truncate">{r.name}</span>
          </Link>
        );
      })}
      {records.length > max ? <span className="text-muted">+{records.length - max}</span> : null}
    </span>
  );
}

/** "Public" when anyone with its link can open it. */
export function PublicBadge({ className }: { className?: string }) {
  return (
    <span className={clsx("inline-flex h-5 items-center gap-1 rounded-full bg-info-surface px-1.5 text-[11px] font-medium text-info", className)} title="Anyone with the link can open this file">
      <GlobeAltIcon className="size-3" aria-hidden />
      Public
    </span>
  );
}

export type MenuFile = { id: string; name: string; uploadedBy: string; publicToken: string | null };

/**
 * Everything you can do with a file, in one menu: open, download, copy a link
 * (the public one when it's public), share or unshare, edit, move, remove.
 */
export function FileMenu({ file, onEdit, onMove, className }: { file: MenuFile; onEdit: () => void; onMove?: () => void; className?: string }) {
  const { canEdit, isAdmin, viewer } = useApp();
  const share = async (visibility: "internal" | "public") => {
    const r = await setFileVisibility(file.id, visibility);
    if (!r.ok) return toast.error(r.error);
    if (visibility === "public" && r.data.token) await copyText(publicFileUrl(r.data.token), `${file.name} is public. Its link is copied.`);
    else toast.success(`${file.name} is internal again. Its public link stopped working.`);
  };
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className={clsx("rounded p-1 text-faint hover:bg-sunken hover:text-primary data-[state=open]:text-primary", className)} aria-label={`Actions for ${file.name}`}>
          <EllipsisHorizontalIcon className="size-4" />
        </button>
      </MenuTrigger>
      <MenuContent className="w-56">
        <MenuItem asChild icon={<ArrowTopRightOnSquareIcon />}>
          <a href={`/api/files/${file.id}`} target="_blank" rel="noopener">
            Open
          </a>
        </MenuItem>
        <MenuItem asChild icon={<ArrowDownTrayIcon />}>
          <a href={`/api/files/${file.id}?download`}>Download</a>
        </MenuItem>
        {file.publicToken ? (
          <MenuItem icon={<GlobeAltIcon />} onSelect={() => copyText(publicFileUrl(file.publicToken!), "Public link copied. Anyone with it can open the file.")}>
            Copy public link
          </MenuItem>
        ) : null}
        <MenuItem icon={<LinkIcon />} onSelect={() => copyText(internalFileUrl(file.id), "Link copied. Teammates sign in to open it.")}>
          Copy team link
        </MenuItem>
        {canEdit ? (
          <>
            <MenuSeparator />
            <MenuItem icon={<PencilSquareIcon />} onSelect={onEdit}>
              Edit and attach to records
            </MenuItem>
            {onMove ? (
              <MenuItem icon={<FolderIcon />} onSelect={onMove}>
                Move to folder
              </MenuItem>
            ) : null}
            {file.publicToken ? (
              <MenuItem icon={<LockClosedIcon />} onSelect={() => share("internal")}>
                Make internal
              </MenuItem>
            ) : (
              <MenuItem icon={<GlobeAltIcon />} onSelect={() => share("public")}>
                Make public and copy link
              </MenuItem>
            )}
            {file.uploadedBy === viewer.id || isAdmin ? (
              <>
                <MenuSeparator />
                <MenuItem
                  destructive
                  icon={<TrashIcon />}
                  onSelect={async () => {
                    if (!confirm(`Remove ${file.name}? It comes off every record it's on, and its links stop working.`)) return;
                    const r = await deleteFile(file.id);
                    if (!r.ok) toast.error(r.error);
                    else toast.success(`${file.name} removed`);
                  }}
                >
                  Remove
                </MenuItem>
              </>
            ) : null}
          </>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

/** An on/off switch with its label beside it. */
export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={clsx("relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-50", on ? "border-accent bg-accent" : "border-line-strong bg-sunken")}
    >
      <span className={clsx("absolute top-0.5 size-3.5 rounded-full bg-surface shadow-sm transition-[left]", on ? "left-[1.125rem]" : "left-0.5")} />
    </button>
  );
}

type Details = NonNullable<Awaited<ReturnType<typeof getFileDetails>>>;

/**
 * Edit a file: its name, its folder, the records it's on (attach it to more,
 * or take it off some), and who can open it. Sharing takes effect right away;
 * the rest saves with Save.
 */
export function FileDialog({ fileId, onClose }: { fileId: string; onClose: () => void }) {
  const [details, setDetails] = useState<Details | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    getFileDetails(fileId).then((d) => live && setDetails(d));
    return () => {
      live = false;
    };
  }, [fileId]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={details?.file.name ?? "File"} description={details ? `${formatBytes(details.file.size)}` : undefined} size="lg">
      {details === undefined ? (
        <div className="flex justify-center py-10">
          <Spinner className="size-5 text-faint" />
        </div>
      ) : details === null ? (
        <p className="py-6 text-center text-[13.5px] text-muted">This file was removed.</p>
      ) : (
        <FileForm details={details} onDone={onClose} />
      )}
    </Dialog>
  );
}

function FileForm({ details, onDone }: { details: Details; onDone: () => void }) {
  const { canEdit, member, services } = useApp();
  const aiFiles = services.ai.files;
  const { file, folders } = details;
  const [name, setName] = useState(file.name);
  const [folderId, setFolderId] = useState(file.folderId ?? "");
  const [records, setRecords] = useState(file.records);
  const [kind, setKind] = useState<EntityType>("client");
  const [token, setToken] = useState(file.publicToken);
  const [description, setDescription] = useState(file.description ?? "");
  const [showNotes, setShowNotes] = useState(false);
  const [pending, start] = useTransition();
  const [sharing, startSharing] = useTransition();
  const key = (r: { entity: string; id: string }) => `${r.entity}:${r.id}`;

  const share = (on: boolean) =>
    startSharing(async () => {
      const r = await setFileVisibility(file.id, on ? "public" : "internal");
      if (!r.ok) return void toast.error(r.error);
      setToken(r.data.token);
      if (on && r.data.token) await copyText(publicFileUrl(r.data.token), "Public link copied. Anyone with it can open the file.");
      else toast.success("The file is internal. Its public link stopped working.");
    });

  const save = () =>
    start(async () => {
      const describedChanged = description.trim() !== (file.description ?? "");
      const changed = name.trim() !== file.name || (folderId || null) !== file.folderId || describedChanged;
      if (changed) {
        const r = await updateFile(file.id, { name, folderId: folderId || null, ...(describedChanged ? { description: description.trim() || null } : {}) });
        if (!r.ok) return void toast.error(r.error);
      }
      const before = new Set(file.records.map(key));
      const after = new Set(records.map(key));
      if (before.size !== after.size || [...after].some((k) => !before.has(k))) {
        const r = await setFileRecords(
          file.id,
          records.map((x) => ({ entity: x.entity, id: x.id })),
        );
        if (!r.ok) return void toast.error(r.error);
      }
      toast.success("File saved");
      onDone();
    });

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} />}</Field>
        <Field label="Folder">
          {(p) => (
            <Select {...p} value={folderId} onChange={(e) => setFolderId(e.target.value)} disabled={!canEdit}>
              <option value="">Top level</option>
              {folderTree<FolderRow>(folders).map((f) => (
                <option key={f.id} value={f.id}>
                  {" ".repeat(f.depth)}
                  {f.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <section>
        <Field
          label="Description"
          hint={
            file.descriptionBy
              ? `Written by ${member(file.descriptionBy)?.name ?? "a teammate"}. Clear it to have it written for you again.`
              : file.description
                ? "Written by AI from what's in the file. Edit it and your version is kept. The agent finds files by their descriptions."
                : file.describeStatus === "skipped"
                  ? "This kind of file can't be read for a description. Write one so the agent can find it."
                  : file.describeStatus === "failed"
                    ? "A description couldn't be written for this file. Write one so the agent can find it."
                    : aiFiles
                      ? "A description is written from what's in the file a moment after it's uploaded."
                      : "Say what's in it, so teammates and the agent can find it."
          }
        >
          {(p) => <Textarea {...p} value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={300} disabled={!canEdit} placeholder="What's in this file" />}
        </Field>
        {file.contentNotes ? (
          <div className="mt-2">
            <button type="button" className="text-[12.5px] font-medium text-muted hover:text-primary" onClick={() => setShowNotes(!showNotes)} aria-expanded={showNotes}>
              {showNotes ? "Hide key facts" : "Show key facts"}
            </button>
            {showNotes ? <p className="mt-1.5 max-h-48 overflow-y-auto rounded-lg border border-line bg-sunken/50 px-3 py-2 text-[12.5px] whitespace-pre-line text-secondary scroll-thin">{file.contentNotes}</p> : null}
          </div>
        ) : null}
      </section>

      <section>
        <h3 className="text-label">Attached to</h3>
        <p className="mt-0.5 text-fine">It shows in the Files card and timeline of each record. With none, it&apos;s a general file.</p>
        {records.length ? (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {records.map((r) => {
              const Icon = recordIcon[r.entity];
              return (
                <li key={key(r)} className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-line bg-sunken pr-1 pl-2.5 text-[12.5px] text-secondary">
                  <Icon className="size-3.5 shrink-0 text-faint" aria-hidden />
                  <span className="truncate">{r.name}</span>
                  {canEdit ? (
                    <button type="button" onClick={() => setRecords(records.filter((x) => key(x) !== key(r)))} className="rounded-full p-0.5 text-faint hover:bg-surface hover:text-primary" aria-label={`Take it off ${r.name}`}>
                      <XMarkIcon className="size-3.5" />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-[13px] text-muted">Not on any record.</p>
        )}
        {canEdit ? (
          <div className="mt-2 flex gap-2">
            <Select value={kind} onChange={(e) => setKind(e.target.value as EntityType)} aria-label="Kind of record" className="w-36 shrink-0">
              <option value="client">Client</option>
              <option value="organization">Organization</option>
              <option value="person">Person</option>
            </Select>
            <div className="min-w-0 flex-1">
              <RecordPicker
                key={`${kind}:${records.length}`}
                kind={kind}
                value={null}
                allowCreate={false}
                placeholder={`Attach to a ${kind}`}
                onChange={(v) => {
                  if (!v || !("record" in v)) return;
                  const r: FileRecord = { entity: kind, id: v.record.id, name: v.record.label, via: "link" };
                  if (!records.some((x) => key(x) === key(r))) setRecords([...records, r]);
                }}
              />
            </div>
          </div>
        ) : null}
      </section>

      <section className="rounded-lg border border-line p-3">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="flex items-center gap-1.5 text-label">
              {token ? <GlobeAltIcon className="size-4 text-info" aria-hidden /> : <LockClosedIcon className="size-4 text-faint" aria-hidden />}
              {token ? "Public: anyone with the link can open it" : "Internal: only signed-in teammates can open it"}
            </h3>
            <p className="mt-0.5 text-fine">{token ? "Send the link to a client. Turn this off and the link stops working." : "Turn this on to get a link you can send to a client. They don't need to sign in."}</p>
          </div>
          {sharing ? <Spinner className="mt-0.5 size-4 text-faint" /> : null}
          <Switch on={!!token} onChange={share} label="Anyone with the link can open it" disabled={!canEdit || sharing} />
        </div>
        {token ? (
          <div className="mt-3 flex gap-2">
            <Input readOnly value={publicFileUrl(token)} onFocus={(e) => e.currentTarget.select()} aria-label="Public link" className="font-mono text-[12.5px]" />
            <Button onClick={() => copyText(publicFileUrl(token), "Public link copied")}>
              <LinkIcon />
              Copy
            </Button>
          </div>
        ) : null}
      </section>

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {canEdit ? "Cancel" : "Close"}
        </Button>
        {canEdit ? (
          <Button variant="primary" onClick={save} loading={pending}>
            Save
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Pick a folder to move files to. */
export function MoveDialog({ folders, current, count, onMove, onClose }: { folders: FolderRow[]; current: string | null; count: number; onMove: (folderId: string | null) => Promise<void>; onClose: () => void }) {
  const [to, setTo] = useState<string>(current ?? "");
  const [pending, start] = useTransition();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={count === 1 ? "Move file" : `Move ${count} files`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={() => start(() => onMove(to || null))}>
            Move
          </Button>
        </>
      }
    >
      <Field label="Folder">
        {(p) => (
          <Select {...p} value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Top level</option>
            {folderTree(folders).map((f) => (
              <option key={f.id} value={f.id}>
                {" ".repeat(f.depth)}
                {f.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </Dialog>
  );
}
