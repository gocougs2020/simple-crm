import "server-only";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { isPrivateAddress } from "./core";

/**
 * Fetches a small document from the public internet on behalf of a stranger
 * (an app's client metadata document) without letting them aim it at
 * private addresses. The address check runs inside the socket's own DNS
 * lookup, so the address that's checked is the address that's connected to:
 * a hostname can't answer with a public address for the check and a private
 * one for the connection (DNS rebinding). No redirects, no connection reuse,
 * 5 seconds and a byte cap. TLS still verifies the original hostname.
 */

const publicOnly: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true, family: options.family ?? 0 }, (err, addresses: LookupAddress[]) => {
    const cb = callback as (err: Error | null, address: string | LookupAddress[], family?: number) => void;
    if (err) return cb(err, "", 0);
    if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) return cb(Object.assign(new Error("Refused: not a public address"), { code: "EPRIVATE" }), "", 0);
    if ((options as { all?: boolean }).all) return cb(null, addresses);
    cb(null, addresses[0].address, addresses[0].family);
  });
};

export class PublicFetchError extends Error {}

export function fetchPublicText(url: string, { maxBytes = 64 * 1024, timeoutMs = 5000 } = {}): Promise<string> {
  // Sockets skip the lookup for an IP address in the URL, so those are checked here.
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isPrivateAddress(host)) return Promise.reject(new PublicFetchError("Refused: not a public address"));
  return new Promise((resolve, reject) => {
    const fail = (why: string) => reject(new PublicFetchError(why));
    const req = request(url, { method: "GET", lookup: publicOnly, agent: false, headers: { accept: "application/json" } }, (res) => {
      // https.request never follows redirects; anything but 200 is a failure.
      if (res.statusCode !== 200) {
        res.resume();
        return fail(`status ${res.statusCode}`);
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy();
          return fail("too large");
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", () => fail("read error"));
    });
    const deadline = setTimeout(() => req.destroy(new Error("timeout")), timeoutMs);
    req.on("close", () => clearTimeout(deadline));
    req.on("error", (err) => fail(err.message));
    req.end();
  });
}
