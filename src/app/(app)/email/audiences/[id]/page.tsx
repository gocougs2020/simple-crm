import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";
import { AudienceEditor } from "@/components/email/audiences";
import { PageSkeleton } from "@/components/ui/skeleton";
import { getDb, schema } from "@/db";
import { allClientTags, allIndustries, allTags } from "@/lib/crm/records";

export const metadata: Metadata = { title: "Audience" };

export default function AudiencePage({ params }: PageProps<"/email/audiences/[id]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Audience params={params} />
    </Suspense>
  );
}

async function Audience({ params }: Pick<PageProps<"/email/audiences/[id]">, "params">) {
  const { id } = await params;
  const [tags, clientTags, industries] = await Promise.all([allTags(), allClientTags(), allIndustries()]);
  if (id === "new") return <AudienceEditor audience={null} tags={tags} clientTags={clientTags} industries={industries} />;
  if (!z.uuid().safeParse(id).success) notFound();
  const db = await getDb();
  const [row] = await db.select().from(schema.audiences).where(eq(schema.audiences.id, id));
  if (!row) notFound();
  return <AudienceEditor audience={row} tags={tags} clientTags={clientTags} industries={industries} />;
}
