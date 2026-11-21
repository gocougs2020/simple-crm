/**
 * The pages a phone visited in this tab, for the top bar's back button
 * (app-shell.tsx). Going to the page before the last one counts as going back,
 * so the trail shrinks again and back never steps out of the CRM.
 */
export function nextTrail(trail: readonly string[], path: string): string[] {
  if (trail.at(-1) === path) return [...trail];
  if (trail.at(-2) === path) return trail.slice(0, -1);
  return [...trail, path];
}

/**
 * Whether history.back() stays in the CRM. The Navigation API knows (it only
 * lists this site's entries); browsers without it fall back to the trail.
 */
export function canGoBackInApp(trail: readonly string[], navigation: { canGoBack?: unknown } | undefined): boolean {
  if (typeof navigation?.canGoBack === "boolean") return navigation.canGoBack;
  return trail.length > 1;
}
