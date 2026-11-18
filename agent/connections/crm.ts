import { defineDynamic, defineMcpClientConnection } from "eve/connections";
import { crmToken, protectionBypass, runOf } from "../lib/run";

/**
 * The CRM's own MCP endpoint, as the teammate this run works for. The CRM
 * decides which tools exist from their role when it lists them, checks the
 * role again on every call, and records each change as "<teammate> via
 * Agent". The token names the run, so it stops working when the run ends
 * or is cancelled. Sessions that aren't a CRM run get no connection at all.
 */
export default defineDynamic((ctx) => {
  const run = runOf(ctx.session.auth.initiator);
  if (!run) return null;
  return defineMcpClientConnection({
    url: `${run.origin}/api/mcp`,
    description: "The CRM: people, organizations, clients, notes, tasks, activity and history. Every read and change goes through here.",
    instanceKey: run.userId,
    headers: protectionBypass(),
    auth: {
      principalType: "user",
      getToken: async () => ({ token: await crmToken(run, "crm"), expiresAt: Date.now() + 8 * 60_000 }),
    },
  });
});
