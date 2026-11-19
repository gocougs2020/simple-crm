import type { Metadata } from "next";
import { Suspense } from "react";
import { z } from "zod";
import { FilesView } from "@/components/files/files-view";
import { PageSkeleton } from "@/components/ui/skeleton";
import { fileViewCounts, fileViews, listFiles, listFolders, type FileView } from "@/lib/crm/files";

export const metadata: Metadata = { title: "Files" };

export default function FilesPage({ searchParams }: PageProps<"/files">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Files searchParams={searchParams} />
    </Suspense>
  );
}

async function Files({ searchParams }: Pick<PageProps<"/files">, "searchParams">) {
  const sp = await searchParams;
  const view: FileView = fileViews.find((v) => v === sp.view) ?? "general";
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const folders = await listFolders();
  const asked = z.uuid().safeParse(sp.folder);
  // A folder that was deleted (or a bad link) opens the top level.
  const folderId = view === "general" && asked.success && folders.some((f) => f.id === asked.data) ? asked.data : null;
  const [rows, counts] = await Promise.all([listFiles({ view, folderId, q }), fileViewCounts()]);
  return <FilesView key={`${view}:${folderId ?? ""}`} view={view} folderId={folderId} q={q} rows={rows} folders={folders} counts={counts} />;
}
