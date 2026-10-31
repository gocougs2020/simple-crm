/**
 * Fractional ranks for ordering cards on the board. A rank is a string of
 * lowercase letters compared with plain string comparison. Moving a card
 * writes only that card: its new rank sits between its new neighbours'.
 * (The midpoint algorithm from David Greenspan's "Implementing fractional
 * indexing"; ranks never end in "a", so there's always room below.)
 */
const DIGITS = "abcdefghijklmnopqrstuvwxyz";

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? DIGITS[0]) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const lo = a ? DIGITS.indexOf(a[0]) : 0;
  const hi = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (hi - lo > 1) return DIGITS[Math.round((lo + hi) / 2)];
  if (b && b.length > 1) return b.slice(0, 1);
  return DIGITS[lo] + midpoint(a.slice(1), null);
}

/** A rank strictly between `before` and `after`. Either side may be missing (start or end of the column). */
export function rankBetween(before?: string | null, after?: string | null): string {
  return midpoint(before ?? "", after ?? null);
}
