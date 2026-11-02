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
  // Everything except public pages, unsubscribe links, the email logo, cron and webhook endpoints (they check their own secrets) and static files.
  matcher: ["/((?!sign-in|setup|forgot|reset|invite|unsubscribe|brand/logo|api/cron|api/webhooks|_next/|favicon|icon|apple-icon|robots.txt).*)"],
};
