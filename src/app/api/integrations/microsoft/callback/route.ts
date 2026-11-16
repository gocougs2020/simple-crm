import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getUser } from "@/lib/auth";
import { GraphError } from "@/lib/microsoft/graph";
import { finishConnect, OAUTH_COOKIE } from "@/lib/microsoft/oauth";
import { siteOrigin } from "@/lib/origin";

/** Microsoft sends the teammate back here after they approve (or decline) the connection. */
export async function GET(request: Request) {
  const origin = await siteOrigin();
  const back = (params: Record<string, string>) => {
    const res = NextResponse.redirect(`${origin}/settings/accounts?${new URLSearchParams(params)}`);
    res.cookies.delete({ name: OAUTH_COOKIE, path: "/api/integrations/microsoft" });
    return res;
  };
  const user = await getUser();
  if (!user) return NextResponse.redirect(`${origin}/sign-in?next=${encodeURIComponent("/settings/accounts")}`);
  const url = new URL(request.url);
  const declined = url.searchParams.get("error");
  if (declined) {
    const detail = url.searchParams.get("error_description")?.split(/\r?\n/)[0]?.slice(0, 200);
    return back({ error: declined === "access_denied" ? "The connection was cancelled, so nothing changed." : `Microsoft didn't connect the account${detail ? `: ${detail}` : ""}.` });
  }
  try {
    const { email } = await finishConnect({
      userId: user.id,
      origin,
      cookie: (await cookies()).get(OAUTH_COOKIE)?.value,
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
    });
    return back({ connected: email });
  } catch (err) {
    if (!(err instanceof GraphError)) console.error("[microsoft] connect", err);
    return back({ error: err instanceof GraphError ? err.message : "Something went wrong connecting the account. Try again in a moment." });
  }
}
