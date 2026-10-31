import type { Metadata } from "next";
import { Suspense } from "react";
import { FilesView } from "@/components/files/files-view";
import { PageSkeleton } from "@/components/ui/skeleton";
import { listFiles } from "@/lib/crm/records";

export const metadata: Metadata = { title: "Files" };

export default function FilesPage({ searchParams }: PageProps<"/files">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Files searchParams={searchParams} />
    </Suspense>
  );
}

async function Files({ searchParams }: Pick<PageProps<"/files">, "searchParams">) {
  const { q } = await searchParams;
  return <FilesView rows={await listFiles({ q: typeof q === "string" ? q : undefined })} />;
}
