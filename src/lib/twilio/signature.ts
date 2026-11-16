import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Twilio signs every webhook (X-Twilio-Signature): HMAC-SHA1, keyed with the
 * account's auth token, over the full URL Twilio called followed by each POST
 * parameter's name and value, sorted by name. Anything that doesn't match is
 * refused, so nobody can fake a call or a text into the CRM.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export function validTwilioSignature(authToken: string, signature: string | null, urls: string[], params: Record<string, string>) {
  if (!signature) return false;
  const got = Buffer.from(signature);
  return urls.some((url) => {
    const want = Buffer.from(twilioSignature(authToken, url, params));
    return want.length === got.length && timingSafeEqual(want, got);
  });
}
