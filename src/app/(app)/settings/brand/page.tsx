import type { Metadata } from "next";
import { Suspense } from "react";
import { BrandSettings } from "@/components/settings/brand";
import { PageSkeleton } from "@/components/ui/skeleton";
import { requireAdminPage } from "@/lib/auth";
import { getWorkspace } from "@/lib/workspace";

export const metadata: Metadata = { title: "Email and brand" };

export default function BrandPage() {
  return (
    <Suspense fallback={<PageSkeleton rows={6} />}>
      <Brand />
    </Suspense>
  );
}

async function Brand() {
  await requireAdminPage();
  const ws = await getWorkspace();
  return <BrandSettings brand={ws.brand} />;
}
