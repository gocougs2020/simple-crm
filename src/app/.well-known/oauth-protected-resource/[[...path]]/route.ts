import { appConfig } from "@/app.config";
import { protectedResourceMetadata } from "@/lib/oauth/core";
import { json, preflight } from "@/lib/oauth/http";
import { siteOrigin } from "@/lib/origin";

/**
 * Protected resource metadata (RFC 9728), at the root and at the MCP path
 * (/.well-known/oauth-protected-resource/api/mcp). An MCP client finds it
 * from the 401 it gets without a token, and learns where to authorize.
 */
export async function GET() {
  return json(protectedResourceMetadata(await siteOrigin(), appConfig.brand.name), 200, { "Cache-Control": "public, max-age=300" });
}
export const OPTIONS = preflight;
