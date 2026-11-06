import type { Metadata } from "next";
import { Suspense } from "react";
import { EmailDomainSettings, type DomainView, type InboxView } from "@/components/settings/email-domains";
import { PageSkeleton } from "@/components/ui/skeleton";
import { getDb, schema } from "@/db";
import { requireAdminPage } from "@/lib/auth";
import { emailDomainsScoped, getResend, inEmailScope } from "@/lib/email";
import { listInboxes } from "@/lib/email/inbox";

export const metadata: Metadata = { title: "Email domains" };

export default function EmailDomainsPage() {
  return (
    <Suspense fallback={<PageSkeleton rows={6} />}>
      <EmailDomains />
    </Suspense>
  );
}

const message = (err: unknown) => (err instanceof Error ? err.message : "Resend didn't answer.");

async function EmailDomains() {
  await requireAdminPage();
  const resend = getResend();
  const db = await getDb();
  const [ws] = await db.select({ email: schema.workspace.email }).from(schema.workspace).limit(1);
  // Never the signing secret: only whether a webhook is connected, and where.
  const webhook = { connected: !!ws?.email.webhookId, endpoint: ws?.email.webhookEndpoint ?? null, envSecret: !!process.env.RESEND_WEBHOOK_SECRET };
  if (!resend) return <EmailDomainSettings configured={false} domains={[]} domainsError={null} scope={{ scoped: emailDomainsScoped, hidden: 0 }} inboxes={[]} inboxesError={null} webhook={webhook} />;

  let domains: DomainView[] = [];
  let domainsError: string | null = null;
  let hidden = 0;
  try {
    const list = await resend.domains.list();
    if (list.error) throw new Error(list.error.message);
    // Only the domains in RESEND_DOMAINS, when set: the Resend account may be shared with other apps.
    const all = list.data?.data ?? [];
    const managed = all.filter((d) => inEmailScope(d.name));
    hidden = all.length - managed.length;
    domains = await Promise.all(
      managed.map(async (d): Promise<DomainView> => {
        const full = await resend.domains.get(d.id);
        return {
          id: d.id,
          name: d.name,
          status: d.status,
          region: d.region,
          sending: d.capabilities?.sending === "enabled",
          receiving: d.capabilities?.receiving === "enabled",
          records: (full.data?.records ?? []).map((r) => ({ record: r.record, type: r.type, name: r.name, value: r.value, priority: "priority" in r ? (r.priority ?? null) : null, status: r.status })),
        };
      }),
    );
  } catch (err) {
    domainsError = message(err);
  }

  let inboxes: InboxView[] = [];
  let inboxesError: string | null = null;
  try {
    inboxes = (await listInboxes()).map((i) => ({ id: i.id, address: i.email_address, name: i.name, fromName: i.from_name, unread: i.unread }));
  } catch (err) {
    inboxesError = message(err);
  }

  return <EmailDomainSettings configured domains={domains} domainsError={domainsError} scope={{ scoped: emailDomainsScoped, hidden }} inboxes={inboxes} inboxesError={inboxesError} webhook={webhook} />;
}
