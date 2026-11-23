import type { Metadata } from "next";
import { Suspense } from "react";
import { ServiceSettings } from "@/components/settings/services";
import { PageSkeleton } from "@/components/ui/skeleton";
import { requireAdminPage } from "@/lib/auth";
import { listProductDescriptions, stripeProductUsage } from "@/lib/crm/product-descriptions";
import { productKey } from "@/lib/product-rules";
import { stripeConfigured } from "@/lib/stripe";

export const metadata: Metadata = { title: "Services" };

export default function ServicesPage() {
  return (
    <Suspense fallback={<PageSkeleton rows={6} />}>
      <Services />
    </Suspense>
  );
}

async function Services() {
  await requireAdminPage();
  const [described, usage] = await Promise.all([listProductDescriptions(), stripeProductUsage()]);
  // Every product Stripe has and every one described, once each: a description can be written before the product exists in Stripe.
  const byKey = new Map<string, { name: string; description: string | null; clients: number; inStripe: boolean }>();
  for (const u of usage) byKey.set(productKey(u.name), { name: u.name, description: null, clients: u.clients, inStripe: true });
  for (const d of described) {
    const seen = byKey.get(productKey(d.name));
    byKey.set(productKey(d.name), seen ? { ...seen, description: d.description } : { name: d.name, description: d.description, clients: 0, inStripe: false });
  }
  const products = [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  return <ServiceSettings products={products} stripe={stripeConfigured()} />;
}
