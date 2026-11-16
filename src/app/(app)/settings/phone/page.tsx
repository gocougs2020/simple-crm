import type { Metadata } from "next";
import { asc } from "drizzle-orm";
import { Suspense } from "react";
import { PhoneSettings } from "@/components/settings/phone";
import { PageSkeleton } from "@/components/ui/skeleton";
import { getDb, schema } from "@/db";
import { requireAdminPage } from "@/lib/auth";
import { siteOrigin } from "@/lib/origin";
import { accessLists } from "@/lib/twilio/access";
import { phoneConfigured } from "@/lib/twilio/config";
import { voiceCredentials } from "@/lib/twilio/setup";
import { getWorkspace } from "@/lib/workspace";

export const metadata: Metadata = { title: "Phone numbers" };

export default function PhonePage() {
  return (
    <Suspense fallback={<PageSkeleton rows={4} />}>
      <Phone />
    </Suspense>
  );
}

async function Phone() {
  await requireAdminPage();
  const configured = phoneConfigured();
  const db = await getDb();
  const rows = (await db.select().from(schema.phoneNumbers).orderBy(asc(schema.phoneNumbers.label))).filter((n) => !n.archivedAt);
  const [access, voice, ws, origin] = await Promise.all([accessLists(rows.map((r) => r.id)), configured ? voiceCredentials() : null, getWorkspace(), siteOrigin()]);
  return (
    <PhoneSettings
      configured={configured}
      calling={{ ready: !!voice, fromEnv: !!process.env.TWILIO_TWIML_APP_SID, origin: ws.phone.webhookOrigin ?? null, currentOrigin: origin }}
      numbers={rows.map((n) => ({ id: n.id, label: n.label, number: n.number, forwardTo: n.forwardTo, forwardUserId: n.forwardUserId, access: n.access, userIds: access.get(n.id) ?? [] }))}
    />
  );
}
