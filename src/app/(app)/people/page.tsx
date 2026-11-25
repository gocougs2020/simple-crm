import type { Metadata } from "next";
import { Suspense } from "react";
import { z } from "zod";
import { PeopleView } from "@/components/people/people-view";
import { PageSkeleton } from "@/components/ui/skeleton";
import { requireUser } from "@/lib/auth";
import { allTags, countPeople, listPeople, pageSize } from "@/lib/crm/records";
import { resolveFilter, visibleFilters } from "@/lib/crm/saved-filters";

export const metadata: Metadata = { title: "People" };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default function PeoplePage({ searchParams }: PageProps<"/people">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <People searchParams={searchParams} />
    </Suspense>
  );
}

async function People({ searchParams }: Pick<PageProps<"/people">, "searchParams">) {
  const sp = await searchParams;
  const user = await requireUser();
  const owner = one(sp.owner);
  const dir = one(sp.dir);
  // As the URL has it ("me" stays "me"), so loading more rows asks for the same list.
  const parent = one(sp.parent);
  const view = { q: one(sp.q), ownerId: owner, organizationId: parent && z.uuid().safeParse(parent).success ? parent : undefined, tag: one(sp.tag), sort: one(sp.sort), dir: dir === "asc" || dir === "desc" ? (dir as "asc" | "desc") : undefined, filterId: one(sp.filter) };
  const [saved, filters] = await Promise.all([resolveFilter(user.id, "person", view.filterId), visibleFilters(user.id, "person")]);
  const filter = { ...view, ownerId: owner === "me" ? user.id : owner, saved: saved.where };
  // The first rows and the total together; the table loads the rest as it's scrolled.
  const [rows, total, tags] = await Promise.all([listPeople(filter), countPeople(filter), allTags()]);
  return (
    <PeopleView
      rows={rows}
      total={total}
      filter={view}
      pageSize={pageSize}
      tags={tags}
      savedFilters={{ filters, active: saved.filter, missing: saved.missing }}
      filtered={!!(filter.q || filter.ownerId || filter.tag || filter.organizationId || view.filterId)}
    />
  );
}
