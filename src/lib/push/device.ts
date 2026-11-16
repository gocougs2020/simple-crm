/** "Chrome on macOS", from a user agent, so people can tell their devices apart in Settings. Pure (tested). */
export function deviceLabel(ua: string | null | undefined, standalone = false) {
  const s = ua ?? "";
  const os = /iPhone/.test(s) ? "iPhone" : /iPad/.test(s) ? "iPad" : /Android/.test(s) ? "Android" : /Mac OS X|Macintosh/.test(s) ? "macOS" : /Windows/.test(s) ? "Windows" : /CrOS/.test(s) ? "ChromeOS" : /Linux/.test(s) ? "Linux" : null;
  const browser = /Edg\//.test(s) ? "Edge" : /SamsungBrowser/.test(s) ? "Samsung Internet" : /Firefox|FxiOS/.test(s) ? "Firefox" : /OPR\//.test(s) ? "Opera" : /Chrome|CriOS/.test(s) ? "Chrome" : /Safari/.test(s) ? "Safari" : null;
  const app = standalone ? "Installed app" : browser;
  if (app && os) return `${app} on ${os}`;
  return app ?? os ?? "This browser";
}

/**
 * The push services browsers use. The server only ever sends to these, so a
 * crafted subscription can't point it at another host.
 */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/];

export function isPushEndpoint(url: string) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.port === "" || u.port === "443") && !u.username && !u.password && PUSH_HOSTS.some((h) => h.test(u.hostname));
  } catch {
    return false;
  }
}
