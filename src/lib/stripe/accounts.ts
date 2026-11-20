/**
 * Which Stripe accounts this deployment reads, from the environment:
 *
 *   STRIPE_SECRET_KEY            the account called "default"
 *   STRIPE_SECRET_KEY_<NAME>     one more account per variable, called <name>
 *   STRIPE_ACCOUNT_LABEL_<NAME>  what the app calls it ("CoRecruit and TalentScout")
 *
 * Kept free of server-only imports so the rules can be tested.
 */
export type StripeAccount = { id: string; label: string; key: string };

const PREFIX = "STRIPE_SECRET_KEY";

export function parseStripeAccounts(env: Record<string, string | undefined>): StripeAccount[] {
  const out: StripeAccount[] = [];
  for (const [name, value] of Object.entries(env)) {
    const key = value?.trim();
    if (!key) continue;
    if (name === PREFIX) out.push({ id: "default", label: env.STRIPE_ACCOUNT_LABEL?.trim() || "Stripe", key });
    else if (name.startsWith(`${PREFIX}_`)) {
      const suffix = name.slice(PREFIX.length + 1);
      if (!/^[A-Z0-9_]+$/.test(suffix)) continue;
      const pretty = suffix.toLowerCase().replace(/_/g, " ");
      out.push({ id: suffix.toLowerCase(), label: env[`STRIPE_ACCOUNT_LABEL_${suffix}`]?.trim() || pretty[0].toUpperCase() + pretty.slice(1), key });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
