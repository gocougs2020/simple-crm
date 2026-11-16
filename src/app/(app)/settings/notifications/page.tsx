import type { Metadata } from "next";
import { Suspense } from "react";
import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { NotificationSettings } from "@/components/settings/notifications";
import { requireUser } from "@/lib/auth";
import { getVapid } from "@/lib/push/vapid";

export const metadata: Metadata = { title: "Notifications" };

export default function NotificationsPage() {
  return (
    <Suspense fallback={null}>
      <Devices />
    </Suspense>
  );
}

async function Devices() {
  const user = await requireUser("/settings/notifications");
  const db = await getDb();
  const s = schema.pushSubscriptions;
  const [rows, vapid] = await Promise.all([
    db.select({ id: s.id, endpoint: s.endpoint, label: s.label, alerts: s.alerts, createdAt: s.createdAt, lastSentAt: s.lastSentAt }).from(s).where(eq(s.userId, user.id)).orderBy(asc(s.createdAt)),
    getVapid(),
  ]);
  return <NotificationSettings publicKey={vapid?.publicKey ?? null} devices={rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), lastSentAt: r.lastSentAt?.toISOString() ?? null }))} />;
}
