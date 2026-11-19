/**
 * A Vercel Blob URL in the one form we store: https, the host lowercased, the
 * path under files/ and matching the upload's pathname, nothing else. Anything
 * else is refused (null), so two spellings of the same stored file can never
 * pass as different uploads.
 */
export function canonicalBlobUrl(raw: string, pathname: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash) return null;
  if (!host.endsWith(".blob.vercel-storage.com") || !pathname.startsWith("files/")) return null;
  if (pathname.split("/").some((part) => !part || part === ".." || part === ".")) return null;
  // One encoding only: the path as Blob writes it. Any other spelling of the same name (%61 for "a") is refused.
  const encoded = `/${pathname.split("/").map(encodeURIComponent).join("/")}`;
  if (u.pathname !== encoded) return null;
  return `https://${host}${encoded}`;
}
