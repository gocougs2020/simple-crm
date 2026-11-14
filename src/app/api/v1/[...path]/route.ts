import type { NextRequest } from "next/server";
import { handleApiRequest } from "@/lib/api/http";

/**
 * The REST API. One catch-all route: src/lib/api/operations.ts lists every
 * endpoint, and the router there finds the right one. Authenticated with API
 * keys only (never the session cookie), so browsers can't be tricked into
 * calling it. Docs at /developers; the OpenAPI document at /api/v1/openapi.json.
 */
const handle = async (request: NextRequest, { params }: RouteContext<"/api/v1/[...path]">) => handleApiRequest(request, (await params).path);

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
