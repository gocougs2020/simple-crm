import type { Metadata } from "next";
import { Suspense } from "react";
import { PeopleView } from "@/components/people/people-view";
import { PageSkeleton } from "@/components/ui/skeleton";
import { requireUser } from "@/lib/auth";
import { allTags, listPeople } from "@/lib/crm/records";

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
  const filter = { q: one(sp.q), ownerId: owner === "me" ? user.id : owner, tag: one(sp.tag), sort: one(sp.sort), dir: one(sp.dir) as "asc" | "desc" | undefined };
  const [rows, tags] = await Promise.all([listPeople(filter), allTags()]);
  return <PeopleView rows={rows} tags={tags} filtered={!!(filter.q || filter.ownerId || filter.tag)} />;
}
