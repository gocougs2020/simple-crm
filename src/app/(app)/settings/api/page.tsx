import type { Metadata } from "next";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Suspense } from "react";
import { ApiSettings, type KeyRow } from "@/components/settings/api-keys";
import { PageSkeleton } from "@/components/ui/skeleton";
import { getDb, schema } from "@/db";
import { isAdmin, requireUser } from "@/lib/auth";
import { siteOrigin } from "@/lib/origin";

export const metadata: Metadata = { title: "API and MCP" };

export default function ApiSettingsPage() {
  return (
    <Suspense fallback={<PageSkeleton rows={4} />}>
      <Keys />
    </Suspense>
  );
}

async function Keys() {
  const user = await requireUser("/settings/api");
  const db = await getDb();
  const k = schema.apiKeys;
  const admin = isAdmin(user);
  const rows = await db
    .select({ key: k, userName: schema.users.name })
    .from(k)
    .leftJoin(schema.users, eq(schema.users.id, k.userId))
    // Admins see every live key, to revoke what's no longer needed; everyone else sees their own.
    .where(and(isNull(k.revokedAt), admin ? undefined : eq(k.userId, user.id)))
    .orderBy(desc(k.createdAt));
  const toRow = (r: (typeof rows)[number]): KeyRow => ({
    id: r.key.id,
    name: r.key.name,
    prefix: r.key.prefix,
    kind: r.key.kind,
    userName: r.userName,
    createdAt: r.key.createdAt,
    lastUsedAt: r.key.lastUsedAt,
    expiresAt: r.key.expiresAt,
    readOnly: r.key.readOnly,
  });
  const mine = rows.filter((r) => r.key.kind === "personal" && r.key.userId === user.id).map(toRow);
  const workspace = rows.filter((r) => r.key.kind === "workspace").map(toRow);
  const apps = rows.filter((r) => r.key.kind === "oauth" && r.key.userId === user.id).map(toRow);
  const teammates = rows.filter((r) => r.key.kind !== "workspace" && r.key.kind !== "assistant" && r.key.userId !== user.id).map(toRow);
  return <ApiSettings origin={await siteOrigin()} mine={mine} apps={apps} workspace={admin ? workspace : null} teammates={admin ? teammates : null} />;
}
