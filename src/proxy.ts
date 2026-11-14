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
  // secrets (cron, webhooks, the REST API, MCP and the OAuth endpoints), OAuth discovery documents, and static files.
  // The OAuth consent page (/oauth/authorize) stays behind it: signed-out visitors sign in first and come back.
  matcher: ["/((?!sign-in|setup|forgot|reset|invite|unsubscribe|developers|brand/logo|api/cron|api/webhooks|api/v1|api/mcp|api/oauth|\\.well-known|_next/|favicon|icon|apple-icon|robots.txt).*)"],
};
