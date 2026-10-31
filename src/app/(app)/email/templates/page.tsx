import type { Metadata } from "next";
import { desc, eq, or } from "drizzle-orm";
import { Suspense } from "react";
import { TemplateList } from "@/components/email/templates";
import { PageSkeleton } from "@/components/ui/skeleton";
import { getDb, schema } from "@/db";
import { requireUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Email templates" };

export default function TemplatesPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Templates />
    </Suspense>
  );
}

async function Templates() {
  const user = await requireUser();
  const db = await getDb();
  const t = schema.emailTemplates;
  const rows = await db
    .select({ id: t.id, name: t.name, subject: t.subject, body: t.body, shared: t.shared, createdBy: t.createdBy })
    .from(t)
    .where(or(eq(t.shared, true), eq(t.createdBy, user.id)))
    .orderBy(desc(t.updatedAt));
  return <TemplateList rows={rows} />;
}
