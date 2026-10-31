"use client";

import { upload } from "@vercel/blob/client";
import { attachUploadedFile } from "@/actions/files";
import { MAX_FILE_BYTES } from "@/lib/constants";

export type FileLinks = { personId?: string | null; organizationId?: string | null; dealId?: string | null };

/** Uploads one file: straight to private Vercel Blob in production, to the dev server's disk locally. Throws a readable message on failure. */
export async function uploadFile(file: File, links: FileLinks, blob: boolean, onProgress?: (pct: number) => void) {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is over ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  if (!blob) {
    const form = new FormData();
    form.set("file", file);
    for (const [k, v] of Object.entries(links)) if (v) form.set(k, v);
    const res = await fetch("/api/files/local", { method: "POST", body: form });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? `Couldn't upload ${file.name}.`);
    onProgress?.(100);
    return json.id as string;
  }
  const safe = file.name.replace(/[^\w.\- ]+/g, "_");
  const result = await upload(`files/${safe}`, file, {
    access: "private",
    handleUploadUrl: "/api/files/upload",
    clientPayload: JSON.stringify({ size: file.size, type: file.type }),
    multipart: file.size > 8 * 1024 * 1024,
    onUploadProgress: (e) => onProgress?.(Math.round(e.percentage)),
  });
  const r = await attachUploadedFile({ url: result.url, pathname: result.pathname, name: file.name, size: file.size, contentType: file.type || "application/octet-stream", ...links });
  if (!r.ok) throw new Error(r.error);
  return r.data.id;
}
