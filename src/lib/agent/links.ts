/**
 * Where a link in one of the agent's answers goes. A page of this CRM (a record, a draft on a
 * person's page, a list) opens in place, in the tab the teammate is in, whether the agent wrote it
 * as a path or as the full address its tools return. Returns that path, or null for anything else
 * (another site, a file download), which opens in a new tab.
 */
export function inAppPath(href: string | undefined, origin: string): string | null {
  if (!href || href.includes("\\")) return null;
  let path: string;
  if (/^\/(?!\/)/.test(href)) path = href;
  else {
    try {
      const url = new URL(href);
      if (!/^https?:$/.test(url.protocol) || url.origin !== origin) return null;
      path = url.pathname + url.search + url.hash;
    } catch {
      return null;
    }
  }
  // Endpoints (a file's download, say) aren't pages.
  return /^\/api(\/|$)/i.test(path) ? null : path;
}
