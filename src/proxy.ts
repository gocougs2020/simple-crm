import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/session-cookie";

/**
 * First line of the login gate: requests without a session cookie go to the
 * sign-in page before anything renders. This is only a fast path; every page,
 * action and route handler still verifies the session itself on the server.
 */
export function proxy(request: NextRequest) {
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();
  const url = request.nextUrl.clone();
  const next = request.nextUrl.pathname + request.nextUrl.search;
  url.pathname = "/sign-in";
  url.search = next === "/" ? "" : `?next=${encodeURIComponent(next)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except public pages (including the API docs), unsubscribe links, the email logo, endpoints that check their own
  // secrets (cron, webhooks, the REST API, MCP, the OAuth endpoints, and the agent's background agent under /eve with the report it sends back), OAuth discovery documents, static files, and what an
  // installed app needs before sign-in (manifest, icons, service worker).
  // The OAuth consent page (/oauth/authorize) stays behind it: signed-out visitors sign in first and come back.
  matcher: ["/((?!sign-in|setup|forgot|reset|invite|unsubscribe|developers|brand/logo|api/cron|api/webhooks|api/v1|api/mcp|api/oauth|api/agent/runs/report|eve/|\\.well-known|_next/|favicon|icon|apple-icon|manifest.webmanifest|sw.js|robots.txt).*)"],
};
