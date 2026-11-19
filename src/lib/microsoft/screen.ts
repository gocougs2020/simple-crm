import "server-only";
import { appConfig } from "@/app.config";
import { aiGatewayAvailable } from "@/lib/agent/config";
import { aiGateway } from "@/lib/agent/gateway";
import { decideSensitive, type ScreenEmail, type ScreenResult } from "./screen-decide";

/**
 * The mail screen: before an email with a contact is stored, a decision
 * model (TypeSafe's Jev by default, through AI Gateway) answers one yes/no
 * question, "is this sensitive?", with a probability. Below
 * `microsoft.privateThreshold` it goes on the record for the team; from there
 * up to `microsoft.screenThreshold` it's kept private to the mailbox's
 * teammate; at or above that it isn't stored. Decision models don't write
 * text, so each email costs a fraction of a cent and comes back fast.
 *
 * When the screen isn't set up or doesn't answer, the email is kept private:
 * nobody vouched for it. With screening switched off (`microsoft.screenMail`)
 * everything goes on the record. Outlook's Private/Confidential labels are
 * checked before this and always keep mail out.
 */

export type { ScreenResult };

export function screeningOn() {
  return appConfig.microsoft.screenMail;
}

export async function screenEmail(m: ScreenEmail, workspaceName: string): Promise<ScreenResult> {
  if (!screeningOn()) return { decision: "import", reason: "Not screened: screening is off", screened: false, score: null };
  if (!aiGatewayAvailable()) return { decision: "private", reason: "Not screened: AI_GATEWAY_API_KEY isn't set", screened: false, score: null };
  return decideSensitive(aiGateway.decisionModel(appConfig.microsoft.screenModel), m, {
    sensitive: appConfig.microsoft.screenInstructions,
    workspaceName,
    threshold: appConfig.microsoft.screenThreshold,
    privateThreshold: appConfig.microsoft.privateThreshold,
  });
}
