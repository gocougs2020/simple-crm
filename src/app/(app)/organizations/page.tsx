import type { Metadata } from "next";
import { Suspense } from "react";
import { OrganizationsView } from "@/components/people/organizations-view";
import { PageSkeleton } from "@/components/ui/skeleton";
import { requireUser } from "@/lib/auth";
import { listOrganizations } from "@/lib/crm/records";

export const metadata: Metadata = { title: "Organizations" };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default function OrganizationsPage({ searchParams }: PageProps<"/organizations">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Organizations searchParams={searchParams} />
    </Suspense>
  );
}

async function Organizations({ searchParams }: Pick<PageProps<"/organizations">, "searchParams">) {
  const sp = await searchParams;
  const user = await requireUser();
  const owner = one(sp.owner);
  const filter = { q: one(sp.q), ownerId: owner === "me" ? user.id : owner, sort: one(sp.sort), dir: one(sp.dir) as "asc" | "desc" | undefined };
  return <OrganizationsView rows={await listOrganizations(filter)} filtered={!!(filter.q || filter.ownerId)} />;
}
