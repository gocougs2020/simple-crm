/**
 * How a record's people are listed, wherever they're picked or shown: the
 * contact first, then the starred decision makers A to Z, then everyone else
 * A to Z. The client's people card, an organization's people card and the
 * composer's pickers all use this, so the same person is in the same place.
 */
export function orderPeople<T>(list: readonly T[], key: (p: T) => { name: string; contact?: boolean; starred?: boolean }): T[] {
  const rank = (k: ReturnType<typeof key>) => (k.contact ? 0 : k.starred ? 1 : 2);
  return list
    .map((p) => ({ p, k: key(p) }))
    .sort((a, b) => rank(a.k) - rank(b.k) || a.k.name.localeCompare(b.k.name, undefined, { sensitivity: "base", numeric: true }))
    .map(({ p }) => p);
}

/** Whether a person matches what was typed in a picker's search box: every word typed appears somewhere in their name, title or email. */
export function matchesPerson(q: string, p: { name: string; email?: string | null; detail?: string | null }) {
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = [p.name, p.email ?? "", p.detail ?? ""].join(" ").toLowerCase();
  return terms.every((t) => hay.includes(t));
}
