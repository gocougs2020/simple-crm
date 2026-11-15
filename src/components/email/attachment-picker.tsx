"use client";

import { useRef, useState } from "react";
import { PaperClipIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { useApp } from "@/components/app-context";
import { Button, Spinner } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { uploadFile, type FileLinks } from "@/components/files/upload";
import type { EmailAttachment } from "@/db/schema";
import { MAX_EMAIL_ATTACHMENT_BYTES, MAX_EMAIL_ATTACHMENTS } from "@/lib/constants";
import { formatBytes } from "@/lib/format";

/**
 * Files to send with an email. Picked files upload right away (to the record
 * named by `links`, so they also show in its Files), and the email keeps
 * their ids. Removing one here only takes it off the email.
 */
export function AttachmentPicker({
  value,
  onChange,
  links = {},
  disabled,
  onUploadingChange,
}: {
  value: EmailAttachment[];
  onChange: (next: EmailAttachment[]) => void;
  links?: FileLinks;
  disabled?: boolean;
  /** True while files are still uploading, so the email can't go without them. */
  onUploadingChange?: (uploading: boolean) => void;
}) {
  const { services } = useApp();
  const picker = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string[]>([]);
  /** Batches of files still uploading (someone can pick more before the first finish). */
  const busy = useRef(0);
  const total = value.reduce((n, a) => n + a.size, 0);

  const add = async (picked: File[]) => {
    if (value.length + picked.length > MAX_EMAIL_ATTACHMENTS) return void toast.error(`Attach up to ${MAX_EMAIL_ATTACHMENTS} files.`);
    const size = total + picked.reduce((n, f) => n + f.size, 0);
    if (size > MAX_EMAIL_ATTACHMENT_BYTES) return void toast.error(`That adds up to ${formatBytes(size)}. Keep attachments under ${formatBytes(MAX_EMAIL_ATTACHMENT_BYTES)}, or share a link instead.`);
    setUploading((u) => [...u, ...picked.map((f) => f.name)]);
    busy.current += 1;
    onUploadingChange?.(true);
    const added: EmailAttachment[] = [];
    for (const f of picked) {
      try {
        const fileId = await uploadFile(f, links, services.blob);
        added.push({ fileId, name: f.name, size: f.size, contentType: f.type || "application/octet-stream" });
      } catch (err) {
        toast.error((err as Error).message);
      } finally {
        setUploading((u) => u.filter((n) => n !== f.name));
      }
    }
    busy.current -= 1;
    if (!busy.current) onUploadingChange?.(false);
    if (added.length) onChange([...value, ...added]);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((a) => (
        <span key={a.fileId} className="inline-flex h-7 max-w-64 items-center gap-1 rounded-full border border-line bg-sunken pr-1 pl-2.5 text-[12px] text-secondary">
          <PaperClipIcon className="size-3.5 shrink-0 text-faint" aria-hidden />
          <a href={`/api/files/${a.fileId}`} target="_blank" rel="noopener" className="truncate hover:text-primary">
            {a.name}
          </a>
          <span className="shrink-0 text-faint tabular-nums">{formatBytes(a.size)}</span>
          {!disabled ? (
            <button type="button" onClick={() => onChange(value.filter((x) => x.fileId !== a.fileId))} className="rounded-full p-0.5 text-faint hover:bg-surface hover:text-primary" aria-label={`Remove ${a.name}`}>
              <XMarkIcon className="size-3.5" />
            </button>
          ) : null}
        </span>
      ))}
      {uploading.map((name) => (
        <span key={name} className="inline-flex h-7 max-w-56 items-center gap-1.5 rounded-full border border-line px-2.5 text-[12px] text-muted">
          <Spinner className="size-3.5" />
          <span className="truncate">{name}</span>
        </span>
      ))}
      {!disabled ? (
        <>
          <Button size="sm" variant="ghost" className="h-7" onClick={() => picker.current?.click()}>
            <PaperClipIcon />
            Attach
          </Button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const picked = [...(e.target.files ?? [])];
              e.target.value = "";
              if (picked.length) void add(picked);
            }}
          />
        </>
      ) : null}
    </div>
  );
}
