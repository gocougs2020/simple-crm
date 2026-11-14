import { json, oauthError, preflight, readForm, throttle } from "@/lib/oauth/http";
import { clientCredentials, revokeToken } from "@/lib/oauth/server";

/** Token revocation (RFC 7009). Answers 200 whether or not the token existed, so it reveals nothing. */
export async function POST(request: Request) {
  try {
    await throttle("oauth-revoke", 120, 60_000);
    const form = await readForm(request);
    await revokeToken(form.get("token"), clientCredentials(request.headers, form));
    return json({});
  } catch (err) {
    return oauthError(err);
  }
}
export const OPTIONS = preflight;
