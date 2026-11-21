import { connection } from "next/server";
import { readSessionCookie } from "@/lib/auth";
import { liveCheck } from "@/lib/live";

const signedOut = () => Response.json({ error: 401, message: "Your session ended. Sign in again to continue." }, { status: 401, headers: { "Cache-Control": "no-store" } });

/**
 * "Has anything changed?" for open pages: the newest change's version
 * (src/lib/live.ts). Signed-in teammates only; it says when, never what.
 * The session check and the version are one statement: one round trip per poll.
 */
export async function GET() {
  await connection();
  const claims = await readSessionCookie();
  if (!claims) return signedOut();
  const { signedIn, v } = await liveCheck(claims);
  if (!signedIn) return signedOut();
  return Response.json({ v }, { headers: { "Cache-Control": "no-store" } });
}
