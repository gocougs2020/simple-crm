import { appConfig } from "@/app.config";
import { buildMarkdown } from "@/lib/api/markdown";
import { siteOrigin } from "@/lib/origin";

/**
 * The developer docs as one Markdown document: authorization, the Zapier
 * guide, every endpoint, model and MCP tool. Public, like /developers: it
 * describes the API, never data. The "Copy as Markdown" button reads it.
 * Cached by the browser only: the site's address in it can come from the
 * request's Host header, so a shared cache mustn't keep one copy for all.
 */
export async function GET() {
  const md = buildMarkdown({ name: appConfig.brand.name, origin: await siteOrigin() });
  return new Response(md, {
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "private, max-age=300", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" },
  });
}
