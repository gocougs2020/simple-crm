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
