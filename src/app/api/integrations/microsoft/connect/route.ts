import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth";
import { microsoftConfigured } from "@/lib/microsoft/config";
import { OAUTH_COOKIE, startConnect } from "@/lib/microsoft/oauth";
import { siteOrigin } from "@/lib/origin";

/** Starts connecting the signed-in teammate's Microsoft 365 mailbox and calendar (Settings → Email and calendar). */
export async function GET(request: Request) {
  const origin = await siteOrigin();
  const user = await getUser();
  if (!user) return NextResponse.redirect(`${origin}/sign-in?next=${encodeURIComponent("/settings/accounts")}`);
  if (!microsoftConfigured()) return NextResponse.redirect(`${origin}/settings/accounts?error=${encodeURIComponent("Microsoft 365 isn't set up on this deployment.")}`);
  const hint = new URL(request.url).searchParams.get("hint") ?? undefined;
  const { url, cookie } = startConnect(user.id, origin, hint?.slice(0, 200));
  const res = NextResponse.redirect(url);
  res.cookies.set(OAUTH_COOKIE, cookie, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/integrations/microsoft", maxAge: 600 });
  return res;
}
