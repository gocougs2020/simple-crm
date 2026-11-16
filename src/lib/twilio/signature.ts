import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Twilio signs every webhook (X-Twilio-Signature): an HMAC over the full URL
 * Twilio called followed by each POST parameter's name and value, sorted by
 * name. By default it's HMAC-SHA1 keyed with the account's auth token; a
 * webhook signing key (SharedKey) signs with its own secret, with SHA-1 or
 * SHA-256, and says so in X-Twilio-Webhooks-Signature-Settings. Anything
 * that doesn't match is refused, so nobody can fake a call or a text into
 * the CRM.
 */
export type SignatureAlgorithm = "sha1" | "sha256";

export function twilioSignature(key: string, url: string, params: Record<string, string>, algorithm: SignatureAlgorithm = "sha1") {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, name) => acc + name + params[name], url);
  return createHmac(algorithm, key).update(Buffer.from(data, "utf8")).digest("base64");
}

/** True when `signature` was made with one of `keys` for one of `urls`. */
export function validTwilioSignature(keys: string | string[], signature: string | null, urls: string[], params: Record<string, string>, algorithm: SignatureAlgorithm = "sha1") {
  if (!signature) return false;
  const got = Buffer.from(signature);
  return [keys].flat().some((key) =>
    urls.some((url) => {
      const want = Buffer.from(twilioSignature(key, url, params, algorithm));
      return want.length === got.length && timingSafeEqual(want, got);
    }),
  );
}

/**
 * The algorithm a webhook signing key used, from
 * `X-Twilio-Webhooks-Signature-Settings: key=…,algorithm=HMAC_SHA256`.
 * Null when the header is absent (Twilio signed with the auth token);
 * "unknown" for an algorithm the CRM doesn't check, which is refused.
 */
export function signingKeyAlgorithm(header: string | null): SignatureAlgorithm | "unknown" | null {
  if (!header) return null;
  const algorithm = /(?:^|[,;\s])algorithm=([A-Za-z0-9_-]+)/.exec(header)?.[1]?.toUpperCase();
  return algorithm === "HMAC_SHA256" ? "sha256" : algorithm === "HMAC_SHA1" ? "sha1" : "unknown";
}
