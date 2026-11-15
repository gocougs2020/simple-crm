import "server-only";

/**
 * VAPID keys identify this server to browsers' push services (RFC 8292).
 * Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (`pnpm dlx web-push
 * generate-vapid-keys`). Locally, a pair is made once and kept in
 * .data/vapid.json; deployed without keys, push stays off. Changing keys
 * signs every device out of notifications, so set them once.
 */
export type Vapid = { publicKey: string; privateKey: string; subject: string };

let cached: Promise<Vapid | null> | null = null;

export function getVapid(): Promise<Vapid | null> {
  cached ??= load().catch((err) => {
    console.error("[push] keys", err);
    cached = null;
    return null;
  });
  return cached;
}

async function load(): Promise<Vapid | null> {
  const subject = process.env.VAPID_SUBJECT || (process.env.NEXT_PUBLIC_SITE_URL?.startsWith("https://") ? process.env.NEXT_PUBLIC_SITE_URL : "mailto:notifications@example.com");
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey } = process.env;
  if (publicKey && privateKey) return { publicKey, privateKey, subject };
  // The local fallback never runs on Vercel: production must not quietly make keys that change on every deploy.
  if (process.env.VERCEL) return null;
  const { readFile, writeFile, mkdir } = await import("node:fs/promises");
  const file = ".data/vapid.json";
  try {
    const saved = JSON.parse(await readFile(file, "utf8")) as { publicKey: string; privateKey: string };
    return { ...saved, subject };
  } catch {
    const keys = (await loadWebPush()).generateVAPIDKeys();
    await mkdir(".data", { recursive: true });
    await writeFile(file, JSON.stringify(keys));
    return { ...keys, subject };
  }
}

export const pushConfigured = async () => !!(await getVapid());

/** web-push is CommonJS: depending on the bundler, its functions are on the module or on `default`. */
export async function loadWebPush(): Promise<typeof import("web-push")> {
  const mod = (await import("web-push")) as typeof import("web-push") & { default?: typeof import("web-push") };
  return mod.default ?? mod;
}
