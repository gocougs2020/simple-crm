"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { run, type Result } from "@/lib/action";
import { ActionError, actionUser } from "@/lib/auth";
import { sessionActor } from "@/lib/crm/actor";
import { fileDetails as loadFileDetails } from "@/lib/crm/files";
import * as svc from "@/lib/crm/service/files";
import { canonicalBlobUrl } from "@/lib/blob-url";
import { blobConfigured } from "@/lib/files";

/**
 * Records a file the browser just uploaded to Vercel Blob. The URL must be on
 * this store and under files/, the path our upload route issues tokens for.
 */
export async function attachUploadedFile(input: svc.UploadInput): Promise<Result<{ id: string }>> {
  return run(async () => {
    const user = await actionUser();
    if (!blobConfigured()) throw new ActionError("File storage isn't set up.");
    const data = svc.uploadInput.parse(input);
    const url = canonicalBlobUrl(data.url, data.pathname);
    if (!url) throw new ActionError("That upload didn't come from file storage.");
    const row = await svc.saveUpload(sessionActor(user), { ...data, url });
    refresh();
    return row;
  });
}

/** Sets every record a file is on: attach it to more, or take it off some. */
export async function setFileRecords(fileId: string, records: svc.FileRecordInput[]): Promise<Result<{ added: number; removed: number }>> {
  return run(async () => {
    const out = await svc.setFileRecords(sessionActor(await actionUser()), fileId, records);
    refresh();
    return out;
  });
}

export async function updateFile(fileId: string, patch: { name?: string; folderId?: string | null; description?: string | null }): Promise<Result> {
  return run(async () => {
    await svc.updateFile(sessionActor(await actionUser()), fileId, z.object({ name: z.string().optional(), folderId: z.uuid().nullable().optional(), description: z.string().max(2000).nullable().optional() }).parse(patch));
    refresh();
  });
}

export async function moveFiles(fileIds: string[], folderId: string | null): Promise<Result> {
  return run(async () => {
    await svc.moveFiles(sessionActor(await actionUser()), fileIds, z.uuid().nullable().parse(folderId));
    refresh();
  });
}

/** Public files open for anyone with the link; internal ones only for signed-in teammates. */
export async function setFileVisibility(fileId: string, visibility: "internal" | "public"): Promise<Result<{ token: string | null }>> {
  return run(async () => {
    const out = await svc.setFileVisibility(sessionActor(await actionUser()), fileId, z.enum(["internal", "public"]).parse(visibility));
    refresh();
    return out;
  });
}

/** Removes a file from the CRM. The uploader or an admin can do this. */
export async function deleteFile(fileId: string): Promise<Result> {
  return run(async () => {
    await svc.deleteFile(sessionActor(await actionUser()), fileId);
    refresh();
  });
}

export async function createFolder(input: { name: string; parentId?: string | null }): Promise<Result<{ id: string }>> {
  return run(async () => {
    const row = await svc.createFolder(sessionActor(await actionUser()), input);
    refresh();
    return row;
  });
}

export async function updateFolder(folderId: string, patch: { name?: string; parentId?: string | null }): Promise<Result> {
  return run(async () => {
    await svc.updateFolder(sessionActor(await actionUser()), folderId, z.object({ name: z.string().optional(), parentId: z.uuid().nullable().optional() }).parse(patch));
    refresh();
  });
}

export async function deleteFolder(folderId: string, choice: { contents: "move"; to: string | null } | { contents: "delete" }): Promise<Result<{ deletedFiles: number }>> {
  return run(async () => {
    const out = await svc.deleteFolder(sessionActor(await actionUser()), folderId, choice);
    refresh();
    return { deletedFiles: out?.deletedFiles ?? 0 };
  });
}

/** What deleting a folder would delete, for the confirmation. */
export async function getFolderContents(folderId: string): Promise<Result<svc.FolderContents>> {
  return run(async () => svc.folderContents(sessionActor(await actionUser()), z.uuid().parse(folderId)));
}

/** A file with every record it's on and every folder, for the file dialog. */
export async function getFileDetails(fileId: string) {
  await actionUser();
  return loadFileDetails(z.uuid().parse(fileId));
}
