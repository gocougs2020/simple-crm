/**
 * The origin from a configured site URL. Tolerates a missing scheme
 * ("crm.example.com"), a trailing slash or a path, so a small slip in
 * NEXT_PUBLIC_SITE_URL can't put scheme-less URLs in OAuth metadata, which
 * MCP clients like Claude can't follow. Returns null when it isn't a URL.
 */
export function siteUrlOrigin(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `${/^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(value) ? "http" : "https"}://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}
