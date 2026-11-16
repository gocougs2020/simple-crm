import "server-only";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Encryption at rest for credentials the CRM keeps on behalf of people:
 * Microsoft 365 tokens and the Twilio API key secret. AES-256-GCM, so a
 * value that was tampered with fails to open instead of decrypting to junk.
 *
 * The key is TOKEN_ENCRYPTION_KEY when set (any long random string), else one
 * derived from AUTH_SECRET. Changing whichever is in use makes stored
 * connections unreadable: teammates reconnect, nothing else is lost.
 */

const VERSION = "v1";

function key(): Buffer {
  const own = process.env.TOKEN_ENCRYPTION_KEY?.trim();
  const base = own || process.env.AUTH_SECRET?.trim();
  if (!base) {
    if (process.env.VERCEL) throw new Error("Set TOKEN_ENCRYPTION_KEY (or AUTH_SECRET) to store connected accounts.");
    return Buffer.from(hkdfSync("sha256", "local-development-secret-change-me", "simple-crm", "token-encryption", 32));
  }
  return Buffer.from(hkdfSync("sha256", base, "simple-crm", "token-encryption", 32));
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `${VERSION}:${iv.toString("base64url")}:${body.toString("base64url")}`;
}

/** Opens a value from `encryptSecret`. Throws if the key changed or the value was altered. */
export function decryptSecret(sealed: string): string {
  const [version, iv, body] = sealed.split(":");
  if (version !== VERSION || !iv || !body) throw new Error("Unrecognized encrypted value.");
  const raw = Buffer.from(body, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString("utf8");
}
