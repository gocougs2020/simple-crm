import type { Metadata } from "next";
import { asc } from "drizzle-orm";
import { Suspense } from "react";
import { TeamSettings } from "@/components/settings/team";
import { PageSkeleton } from "@/components/ui/skeleton";
import { getDb, schema } from "@/db";

export const metadata: Metadata = { title: "Team" };

export default function TeamPage() {
  return (
    <Suspense fallback={<PageSkeleton rows={4} />}>
      <Team />
    </Suspense>
  );
}

async function Team() {
  const db = await getDb();
  const users = await db.select().from(schema.users).orderBy(asc(schema.users.name));
  const order = { owner: 0, admin: 1, member: 2 } as Record<string, number>;
  const rows = users
    .map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, title: u.title, invited: !u.passwordHash, deactivated: !!u.deactivatedAt, lastSeenAt: u.lastSeenAt }))
    .sort((a, b) => Number(a.deactivated) - Number(b.deactivated) || order[a.role] - order[b.role] || a.name.localeCompare(b.name));
  return <TeamSettings rows={rows} />;
}
