import type { Metadata } from "next";
import { count } from "drizzle-orm";
import { Suspense } from "react";
import { WorkspaceSettings } from "@/components/settings/workspace";
import { PageSkeleton } from "@/components/ui/skeleton";
import { getDb, schema } from "@/db";
import { requireAdminPage } from "@/lib/auth";

export const metadata: Metadata = { title: "Workspace" };

export default function WorkspacePage() {
  return (
    <Suspense fallback={<PageSkeleton rows={3} />}>
      <Workspace />
    </Suspense>
  );
}

async function Workspace() {
  await requireAdminPage();
  const db = await getDb();
  const [{ n }] = await db.select({ n: count() }).from(schema.people);
  return <WorkspaceSettings canAddSample={!process.env.VERCEL && n === 0} />;
}
