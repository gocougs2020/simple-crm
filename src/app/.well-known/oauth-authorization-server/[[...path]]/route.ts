import { authorizationServerMetadata } from "@/lib/oauth/core";
import { json, preflight } from "@/lib/oauth/http";
import { siteOrigin } from "@/lib/origin";

/** Authorization server metadata (RFC 8414). Also answered under a path, for clients that insert the resource path. */
export async function GET() {
  return json(authorizationServerMetadata(await siteOrigin()), 200, { "Cache-Control": "public, max-age=300" });
}
export const OPTIONS = preflight;
