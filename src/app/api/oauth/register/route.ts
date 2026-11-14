import { json, oauthError, preflight, readJson, throttle } from "@/lib/oauth/http";
import { registerClient } from "@/lib/oauth/server";

/** Dynamic client registration (RFC 7591): how Claude, ChatGPT and most MCP clients introduce themselves. Registering grants nothing on its own. */
export async function POST(request: Request) {
  try {
    await throttle("oauth-register", 20, 3600_000);
    return json(await registerClient(await readJson(request)), 201);
  } catch (err) {
    return oauthError(err);
  }
}
export const OPTIONS = preflight;
