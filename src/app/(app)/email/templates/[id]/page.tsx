import type { Metadata } from "next";
import { and, eq, or } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";
import { TemplateEditor } from "@/components/email/templates";
import { PageSkeleton } from "@/components/ui/skeleton";
import { getDb, schema } from "@/db";
import { requireUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Email template" };

export default function TemplatePage({ params }: PageProps<"/email/templates/[id]">) {
  return (
    <Suspense fallback={<PageSkeleton rows={4} />}>
      <Template params={params} />
    </Suspense>
  );
}

async function Template({ params }: Pick<PageProps<"/email/templates/[id]">, "params">) {
  const { id } = await params;
  if (id === "new") return <TemplateEditor template={null} />;
  if (!z.uuid().safeParse(id).success) notFound();
  const user = await requireUser();
  const db = await getDb();
  const t = schema.emailTemplates;
  const [row] = await db
    .select({ id: t.id, name: t.name, subject: t.subject, body: t.body, shared: t.shared, createdBy: t.createdBy })
    .from(t)
    .where(and(eq(t.id, id), or(eq(t.shared, true), eq(t.createdBy, user.id))));
  if (!row) notFound();
  return <TemplateEditor template={row} />;
}
