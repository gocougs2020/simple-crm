import { getUser } from "@/lib/auth";
import { latestChange } from "@/lib/live";

/**
 * "Has anything changed?" for open pages: the newest change's version
 * (src/lib/live.ts). Signed-in teammates only; it says when, never what.
 */
export async function GET() {
  // Both at once: one round trip to the database instead of two.
  const [user, v] = await Promise.all([getUser(), latestChange()]);
  if (!user) return Response.json({ error: 401, message: "Your session ended. Sign in again to continue." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  return Response.json({ v }, { headers: { "Cache-Control": "no-store" } });
}
