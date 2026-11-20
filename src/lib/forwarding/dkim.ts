import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";

/**
 * DKIM signature checks (RFC 6376) for email forwarded to the agent. We check
 * the signature ourselves, from the raw message, instead of trusting a header
 * the sender could have written. Pure apart from the key lookup, which the
 * caller passes in (DNS in production, a fixed key in tests).
 *
 * Supports rsa-sha256 and ed25519-sha256 with simple and relaxed
 * canonicalization. Signatures with an `l=` body length are refused: they
 * leave room to append content the signature doesn't cover.
 */

/** One signature's outcome. `signed` lists the headers it covers (lowercase), so callers can tell which lines can be trusted. */
export type DkimResult = { domain: string; selector: string; ok: boolean; reason?: string; signed?: string[] };
/** The reason given when DNS didn't answer for a key, so the caller can try again later instead of refusing. */
export const LOOKUP_FAILED = "its public key couldn't be looked up";

/** Looks up the TXT record at `<selector>._domainkey.<domain>`, joined into one string, or null when there's none. */
export type KeyLookup = (name: string) => Promise<string | null>;

type RawHeader = { name: string; raw: string };

/** The message as text that keeps every byte (latin1), with CRLF line endings, split into its header lines and body. */
export function splitMessage(raw: Buffer | string) {
  const text = (typeof raw === "string" ? raw : raw.toString("latin1")).replace(/\r?\n/g, "\r\n");
  const end = text.indexOf("\r\n\r\n");
  const head = end === -1 ? text : text.slice(0, end + 2);
  const body = end === -1 ? "" : text.slice(end + 4);
  const headers: RawHeader[] = [];
  for (const line of head.split(/(?<=\r\n)/)) {
    if (!line || line === "\r\n") continue;
    if (/^[ \t]/.test(line) && headers.length) headers[headers.length - 1].raw += line;
    else {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      headers.push({ name: line.slice(0, colon).trim().toLowerCase(), raw: line });
    }
  }
  return { headers, body };
}

/** A header's value, unfolded. */
export const headerValue = (h: RawHeader) => h.raw.slice(h.raw.indexOf(":") + 1).replace(/\r\n(?=[ \t])/g, "").trim();

function canonHeader(h: RawHeader, relaxed: boolean) {
  if (!relaxed) return h.raw.endsWith("\r\n") ? h.raw : `${h.raw}\r\n`;
  const value = h.raw
    .slice(h.raw.indexOf(":") + 1)
    .replace(/\r\n(?=[ \t])/g, "")
    .replace(/\r\n$/, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  return `${h.name}:${value}\r\n`;
}

export function canonBody(body: string, relaxed: boolean) {
  let lines = body.split("\r\n");
  if (relaxed) lines = lines.map((l) => l.replace(/[ \t]+/g, " ").replace(/ $/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (!lines.length) return relaxed ? "" : "\r\n";
  return `${lines.join("\r\n")}\r\n`;
}

/** `v=1; a=rsa-sha256; …` as a map. Whitespace inside values (folding, b= and bh=) is dropped. */
export function tagList(value: string) {
  const tags: Record<string, string> = {};
  for (const part of value.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k) tags[k] = part.slice(eq + 1).replace(/\s+/g, "");
  }
  return tags;
}

function publicKey(record: string, algorithm: "rsa" | "ed25519"): KeyObject | null {
  const t = tagList(record);
  if ((t.k ?? "rsa") !== algorithm || !t.p) return null;
  const der = Buffer.from(t.p, "base64");
  if (algorithm === "ed25519") {
    // DNS holds the bare 32-byte key; wrap it in the SubjectPublicKeyInfo prefix Node expects.
    return createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), der]), format: "der", type: "spki" });
  }
  try {
    return createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    return createPublicKey({ key: der, format: "der", type: "pkcs1" });
  }
}

/** Checks one DKIM-Signature header against the message. */
async function checkSignature(sig: RawHeader, headers: RawHeader[], body: string, lookup: KeyLookup, now: Date): Promise<DkimResult> {
  const t = tagList(headerValue(sig));
  const domain = (t.d ?? "").toLowerCase();
  const selector = t.s ?? "";
  const fail = (reason: string): DkimResult => ({ domain, selector, ok: false, reason });
  if (t.v !== "1" || !domain || !selector || !t.b || !t.bh || !t.h) return fail("the signature is incomplete");
  if (t.l !== undefined) return fail("the signature covers only part of the body (l=)");
  const algorithm = t.a === "rsa-sha256" ? "rsa" : t.a === "ed25519-sha256" ? "ed25519" : null;
  if (!algorithm) return fail(`${t.a ?? "no"} algorithm isn't accepted`);
  if (t.x && Number(t.x) * 1000 < now.getTime()) return fail("the signature has expired");
  const signed = t.h.toLowerCase().split(":").filter(Boolean);
  if (!signed.includes("from")) return fail("the signature doesn't cover the From line");
  const [headerCanon, bodyCanon = "simple"] = (t.c ?? "simple/simple").toLowerCase().split("/");

  const bodyHash = createHash("sha256").update(Buffer.from(canonBody(body, bodyCanon === "relaxed"), "latin1")).digest("base64");
  if (bodyHash !== t.bh) return fail("the body was changed after it was signed");

  // Each name in h= takes the last instance of that header not used yet (RFC 6376 5.4.2).
  const used = new Set<RawHeader>();
  let data = "";
  for (const name of signed) {
    const found = [...headers].reverse().find((h) => h.name === name && !used.has(h));
    if (!found) continue;
    used.add(found);
    data += canonHeader(found, headerCanon === "relaxed");
  }
  // The signature header itself, with its b= value emptied and no line break at the end.
  const blank: RawHeader = { name: sig.name, raw: sig.raw.replace(/(\bb[ \t]*=)[^;]*/, "$1") };
  data += canonHeader(blank, headerCanon === "relaxed").replace(/\r\n$/, "");

  let record: string | null;
  try {
    record = await lookup(`${selector}._domainkey.${domain}`);
  } catch {
    return fail(LOOKUP_FAILED);
  }
  if (!record) return fail("its public key isn't published");
  let key: KeyObject | null;
  try {
    key = publicKey(record, algorithm);
  } catch {
    key = null;
  }
  if (!key) return fail("its public key is missing or revoked");
  const signature = Buffer.from(t.b, "base64");
  const bytes = Buffer.from(data, "latin1");
  const ok = algorithm === "rsa" ? verify("sha256", bytes, key, signature) : verify(null, createHash("sha256").update(bytes).digest(), key, signature);
  return ok ? { domain, selector, ok: true, signed } : fail("the signature doesn't match");
}

/** Every DKIM signature on the message and whether it holds. */
export async function verifyDkim(raw: Buffer | string, lookup: KeyLookup, now = new Date()): Promise<DkimResult[]> {
  const { headers, body } = splitMessage(raw);
  const sigs = headers.filter((h) => h.name === "dkim-signature").slice(0, 5);
  return Promise.all(sigs.map((s) => checkSignature(s, headers, body, lookup, now)));
}

/**
 * Whether a signing domain is aligned with the From domain (DMARC relaxed
 * alignment): the same domain, or one inside the other. A one-label domain
 * ("com") never counts.
 */
export function aligned(fromDomain: string, signingDomain: string) {
  const a = fromDomain.toLowerCase().replace(/\.$/, "");
  const b = signingDomain.toLowerCase().replace(/\.$/, "");
  if (!a.includes(".") || !b.includes(".")) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}
