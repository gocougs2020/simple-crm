import { json, oauthError, preflight, readForm, throttle } from "@/lib/oauth/http";
import { clientCredentials, exchangeCode, OAuthError, refreshTokens } from "@/lib/oauth/server";
import { siteOrigin } from "@/lib/origin";

/** The token endpoint: trades an authorization code (with its PKCE verifier) or a refresh token for tokens. */
export async function POST(request: Request) {
  try {
    await throttle("oauth-token", 120, 60_000);
    const form = await readForm(request);
    const creds = clientCredentials(request.headers, form);
    const grant = form.get("grant_type");
    if (grant === "authorization_code") return json(await exchangeCode(form, creds, await siteOrigin()));
    if (grant === "refresh_token") return json(await refreshTokens(form, creds));
    throw new OAuthError("unsupported_grant_type", "Use grant_type authorization_code or refresh_token.");
  } catch (err) {
    return oauthError(err);
  }
}
export const OPTIONS = preflight;
