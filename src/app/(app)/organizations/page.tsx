import type { Metadata } from "next";
import { Suspense } from "react";
import { z } from "zod";
import { OrganizationsView } from "@/components/people/organizations-view";
import { PageSkeleton } from "@/components/ui/skeleton";
import { requireUser } from "@/lib/auth";
import { countOrganizations, listOrganizations, pageSize } from "@/lib/crm/records";
import { resolveFilter, visibleFilters } from "@/lib/crm/saved-filters";

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
  const dir = one(sp.dir);
  // As the URL has it ("me" stays "me"), so loading more rows asks for the same list.
  const parent = one(sp.parent);
  const view = { q: one(sp.q), tag: one(sp.tag), ownerId: owner, parentId: parent === "parents" || z.uuid().safeParse(parent).success ? parent : undefined, sort: one(sp.sort), dir: dir === "asc" || dir === "desc" ? (dir as "asc" | "desc") : undefined, filterId: one(sp.filter) };
  const [saved, filters] = await Promise.all([resolveFilter(user.id, "organization", view.filterId), visibleFilters(user.id, "organization")]);
  const filter = { ...view, ownerId: owner === "me" ? user.id : owner, saved: saved.where };
  // The first rows and the total together; the table loads the rest as it's scrolled.
  const [rows, total] = await Promise.all([listOrganizations(filter), countOrganizations(filter)]);
  return (
    <OrganizationsView
      rows={rows}
      total={total}
      filter={view}
      pageSize={pageSize}
      savedFilters={{ filters, active: saved.filter, missing: saved.missing }}
      filtered={!!(filter.q || filter.ownerId || filter.parentId || filter.tag || view.filterId)}
    />
  );
}
