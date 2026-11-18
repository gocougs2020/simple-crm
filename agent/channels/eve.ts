import { extractBearerToken, localDev, type AuthFn } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { verifyRunToken } from "../../src/lib/agent/run-token";

/**
 * Who may start or continue a session: only the CRM, with a token it signed
 * for one run and one teammate (src/lib/agent/run-token.ts). The session then
 * runs as that teammate. Browsers never call the agent directly.
 */
const crmRun: AuthFn<Request> = async (request) => {
  const claims = await verifyRunToken("eve", extractBearerToken(request.headers.get("authorization")));
  if (!claims) return null;
  return {
    authenticator: "crm",
    principalId: claims.userId,
    principalType: "user",
    attributes: { runId: claims.runId, origin: claims.origin },
  };
};

export default eveChannel({
  // localDev() only answers under `eve dev`, for the terminal UI. Those sessions have no run, so no CRM access.
  auth: [crmRun, localDev()],
});
