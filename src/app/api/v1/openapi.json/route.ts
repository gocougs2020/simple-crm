import { appConfig } from "@/app.config";
import { buildOpenApi } from "@/lib/api/openapi";
import { siteOrigin } from "@/lib/origin";

/** The OpenAPI 3.1 document for /api/v1. Public: it describes the API, never data. */
export async function GET() {
  const origin = await siteOrigin();
  const doc = buildOpenApi({ title: `${appConfig.brand.name} API`, serverUrl: `${origin}/api/v1`, description: `Docs: ${origin}/developers` });
  return Response.json(doc, { headers: { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" } });
}
