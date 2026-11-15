/** "Chrome on macOS", from a user agent, so people can tell their devices apart in Settings. Pure (tested). */
export function deviceLabel(ua: string | null | undefined, standalone = false) {
  const s = ua ?? "";
  const os = /iPhone/.test(s) ? "iPhone" : /iPad/.test(s) ? "iPad" : /Android/.test(s) ? "Android" : /Mac OS X|Macintosh/.test(s) ? "macOS" : /Windows/.test(s) ? "Windows" : /CrOS/.test(s) ? "ChromeOS" : /Linux/.test(s) ? "Linux" : null;
  const browser = /Edg\//.test(s) ? "Edge" : /SamsungBrowser/.test(s) ? "Samsung Internet" : /Firefox|FxiOS/.test(s) ? "Firefox" : /OPR\//.test(s) ? "Opera" : /Chrome|CriOS/.test(s) ? "Chrome" : /Safari/.test(s) ? "Safari" : null;
  const app = standalone ? "Installed app" : browser;
  if (app && os) return `${app} on ${os}`;
  return app ?? os ?? "This browser";
}
