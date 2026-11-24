/**
 * How a Stripe product's name finds its description (Settings → Services):
 * the same name, ignoring case and spaces at the ends. Pure, so the browser
 * and the server match the same way.
 */
export const productKey = (name: string) => name.trim().toLowerCase();

export function productDescriber(rows: readonly { name: string; description: string }[]) {
  const byKey = new Map(rows.map((r) => [productKey(r.name), r.description]));
  return (name: string): string | null => byKey.get(productKey(name)) ?? null;
}

/** The product lines the Clients page groups Stripe products into, in the order the filter lists them. */
export const productFamilies = ["TalentScout", "CoRecruit", "ThirdPool", "HiringCenter", "VRA"] as const;
export type ProductFamily = (typeof productFamilies)[number];

/**
 * Which product line a Stripe product belongs to, from its name. Names that
 * don't say it outright come first: "Contract Recruiter Services" and
 * "Virtual Recruiting Assistant" are VRA, "HiringCenter + Recruitment
 * Marketing" and a bare "Subscription" are ThirdPool, and Recruit365 is
 * CoRecruit. Null for anything else (office rental, tests).
 */
export function productFamily(name: string): ProductFamily | null {
  const n = productKey(name);
  if (n.includes("contract recruiter") || n.includes("virtual recruiting assistant")) return "VRA";
  if (n.includes("hiringcenter + recruitment marketing") || n === "subscription") return "ThirdPool";
  if (n.includes("recruit365")) return "CoRecruit";
  for (const f of productFamilies) if (n.includes(f.toLowerCase())) return f;
  return null;
}

/** The product lines among a client's Stripe products, each once, in the filter's order. */
export function productFamiliesOf(names: readonly string[]): ProductFamily[] {
  const found = new Set(names.map(productFamily));
  return productFamilies.filter((f) => found.has(f));
}

/**
 * What the Stripe sync sets a client's product lines to: the lines their
 * running subscriptions belong to. Null leaves them as they are, either because
 * nothing running belongs to a line (a prospect, a past client, an office
 * rental), so lines set by hand stay, or because nothing changed.
 */
export function syncedProductLines(stripeProducts: readonly string[], current: readonly string[]): ProductFamily[] | null {
  const next = productFamiliesOf(stripeProducts);
  if (!next.length) return null;
  return next.length === current.length && next.every((f, i) => f === current[i]) ? null : next;
}
