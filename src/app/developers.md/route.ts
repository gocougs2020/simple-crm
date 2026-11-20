import { appConfig } from "@/app.config";
import { buildMarkdown } from "@/lib/api/markdown";
import { siteOrigin } from "@/lib/origin";

/**
 * The developer docs as one Markdown document: authorization, the Zapier
 * guide, every endpoint, model and MCP tool. Public, like /developers: it
 * describes the API, never data. The "Copy as Markdown" button reads it.
 */
export async function GET() {
  const md = buildMarkdown({ name: appConfig.brand.name, origin: await siteOrigin() });
  return new Response(md, {
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" },
  });
}
