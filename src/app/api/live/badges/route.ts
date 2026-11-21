import { getUser } from "@/lib/auth";
import { badgesFor } from "@/lib/sidebar-counts";

/**
 * The sidebar's badges in one statement (src/lib/sidebar-counts.ts), for an
 * open page whose own content didn't change when the team chat, a conversation
 * or someone's due work did: the badges update without re-rendering the page.
 */
export async function GET() {
  const user = await getUser();
  if (!user) return Response.json({ error: 401, message: "Your session ended. Sign in again to continue." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  return Response.json(await badgesFor(user), { headers: { "Cache-Control": "no-store" } });
}
