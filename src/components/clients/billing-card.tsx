import { SideCard } from "@/components/records/inline-field";
import { stripeAccounts, stripeConfigured } from "@/lib/stripe";
import { clientBilling } from "@/lib/stripe/client-billing";
import { BillingView } from "./billing-view";

/**
 * Stripe billing on every client, prospects included: the customers whose
 * email is one of the client's people's, in every connected account, with
 * their subscriptions, invoices, payments and saved cards read live. Renders
 * in its own Suspense boundary so a slow Stripe never holds up the page.
 */
export async function BillingCard({ clientId, syncedAt, suggest }: { clientId: string; syncedAt: Date | null; suggest: string | null }) {
  if (!stripeConfigured())
    return (
      <SideCard title="Billing">
        <p className="py-1 text-[12.5px] text-muted">
          Connect Stripe to see subscriptions, invoices and payments here. Add a restricted, read-only key to the environment as STRIPE_SECRET_KEY, or one per Stripe account as STRIPE_SECRET_KEY_NAME.
        </p>
      </SideCard>
    );
  const { customers, failed, more } = await clientBilling(clientId, syncedAt);
  return <BillingView clientId={clientId} customers={customers} failed={failed} more={more} accounts={stripeAccounts()} suggest={suggest} />;
}
