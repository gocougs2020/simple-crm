import type { Metadata } from "next";
import { Suspense } from "react";
import { LabelSettings } from "@/components/settings/labels";
import { PageSkeleton } from "@/components/ui/skeleton";
import { requireAdminPage } from "@/lib/auth";
import { labelUsage, listLabels } from "@/lib/crm/labels";

export const metadata: Metadata = { title: "Labels" };

export default function LabelsPage() {
  return (
    <Suspense fallback={<PageSkeleton rows={6} />}>
      <Labels />
    </Suspense>
  );
}

async function Labels() {
  await requireAdminPage();
  const [defined, usage] = await Promise.all([listLabels(), labelUsage()]);
  // Labels on records that nobody has described yet are listed too, so nothing in use is missing here.
  const names = new Set(defined.map((l) => l.name));
  const loose = Object.keys(usage)
    .filter((n) => !names.has(n))
    .map((name) => ({ id: null, name, description: null, hidden: false }));
  return <LabelSettings labels={[...defined, ...loose].sort((a, b) => a.name.localeCompare(b.name))} usage={usage} />;
}
