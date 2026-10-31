import type { Metadata } from "next";
import { asc } from "drizzle-orm";
import { Suspense } from "react";
import { FieldSettings } from "@/components/settings/fields";
import { PageSkeleton } from "@/components/ui/skeleton";
import { getDb, schema } from "@/db";
import { requireAdminPage } from "@/lib/auth";

export const metadata: Metadata = { title: "Custom fields" };

export default function FieldsPage() {
  return (
    <Suspense fallback={<PageSkeleton rows={6} />}>
      <Fields />
    </Suspense>
  );
}

async function Fields() {
  await requireAdminPage();
  const db = await getDb();
  const fields = await db.select().from(schema.customFields).orderBy(asc(schema.customFields.position), asc(schema.customFields.createdAt));
  return <FieldSettings fields={fields} />;
}
