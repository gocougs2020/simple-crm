/**
 * Which mail the mailbox sync looks at, and what it does with the screen's
 * answer. Pure, so it's tested on its own and the settings form can use it.
 */

/** Where anyone can get an address: never treated as "our own domain", even when a teammate's mailbox is on one. */
const PUBLIC_MAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com"]);

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1);

/**
 * Our own organization's email domains: the domain of every connected mailbox
 * (work accounts) plus `microsoft.internalDomains`. Everyone at one of these
 * is on our side, whether or not they have a CRM login.
 */
export function internalDomains(mailboxes: string[], extra: readonly string[] = []) {
  const out = new Set<string>();
  for (const m of mailboxes) {
    const d = domainOf(m.trim().toLowerCase());
    if (d && !PUBLIC_MAIL.has(d)) out.add(d);
  }
  for (const d of extra) {
    const clean = d.trim().toLowerCase().replace(/^@/, "");
    if (clean) out.add(clean);
  }
  return out;
}

/** Whether an address is one of ours: a teammate's own address, or anyone at one of our domains. */
export function isInternal(address: string, team: Set<string>, domains: Set<string>) {
  const a = address.toLowerCase();
  return team.has(a) || domains.has(domainOf(a));
}

/** Everyone on an email who isn't us, each address once, lowercased. Only these can put an email on a record. */
export function outsiders(addresses: string[], team: Set<string>, domains: Set<string>) {
  return [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter((a) => a.includes("@") && !isInternal(a, team, domains)))];
}

const ENTRY = /^(?:[^\s@,;]+@)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
export const MAX_BLOCKED = 200;

/**
 * A block list as the teammate typed it (one per line, or separated by commas)
 * into clean entries: full addresses and bare domains, lowercased, each once.
 * `invalid` is what didn't look like either; `tooMany` says the list ran past `MAX_BLOCKED`.
 */
export function parseBlockList(input: string | string[]) {
  const parts = (Array.isArray(input) ? input : input.split(/[\s,;]+/)).map((p) => p.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  const entries: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    if (!ENTRY.test(p)) invalid.push(p);
    else if (!entries.includes(p)) entries.push(p);
  }
  return { entries: entries.slice(0, MAX_BLOCKED), invalid, tooMany: entries.length > MAX_BLOCKED };
}

/** Whether any of these addresses is on the block list: the address itself, its domain, or a subdomain of a blocked domain. */
export function isBlocked(addresses: string[], blocked: readonly string[]) {
  if (!blocked.length) return false;
  return addresses.some((raw) => {
    const a = raw.toLowerCase();
    const d = domainOf(a);
    return blocked.some((b) => (b.includes("@") ? b === a : d === b || d.endsWith(`.${b}`)));
  });
}

export type Visibility = "public" | "private" | "withhold";

/**
 * What the screen's probability of "sensitive" means for an email: fairly
 * sure it's fine, it goes on the record for the team; unsure, it's kept
 * private to the mailbox's teammate; very sure it's sensitive, it isn't stored.
 */
export function visibilityFor(probability: number, t: { private: number; withhold: number }): Visibility {
  const clamp = (n: number, fallback: number) => (Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : fallback);
  const withhold = clamp(t.withhold, 0.85);
  const priv = Math.min(clamp(t.private, 0.5), withhold);
  return probability >= withhold ? "withhold" : probability >= priv ? "private" : "public";
}
