import "server-only";
import { generateText, Output } from "ai";
import { z } from "zod";
import { appConfig } from "@/app.config";
import { aiGatewayAvailable } from "@/lib/agent/config";
import { aiGateway } from "@/lib/agent/gateway";
import { screenInstructions, screenPrompt } from "./screen-prompt";

/**
 * The AI screen for synced mail: a small model reads each email from a
 * contact before it's copied to their record and keeps out anything private
 * or confidential (`microsoft.screenInstructions` says what that means here).
 */

const verdict = z.object({
  sensitive: z.boolean(),
  reason: z.string().max(200),
});

export type ScreenResult = { decision: "import" | "withhold"; reason: string } | { decision: "wait"; reason: string };

export function screeningOn() {
  return appConfig.microsoft.screenMail;
}

export async function screenEmail(m: { from: string; to: string[]; subject: string | null; text: string }, workspaceName: string): Promise<ScreenResult> {
  if (!screeningOn()) return { decision: "import", reason: "Screening is off" };
  if (!aiGatewayAvailable()) return { decision: "wait", reason: "Waiting for the AI screen: AI_GATEWAY_API_KEY isn't set." };
  try {
    const { output } = await generateText({
      model: aiGateway(appConfig.microsoft.screenModel),
      output: Output.object({ schema: verdict }),
      system: screenInstructions(appConfig.microsoft.screenInstructions, workspaceName),
      prompt: screenPrompt(m),
      maxOutputTokens: 400,
    });
    return output.sensitive ? { decision: "withhold", reason: output.reason.trim() || "Looked private" } : { decision: "import", reason: output.reason.trim() };
  } catch (err) {
    console.error("[microsoft] screen", err);
    return { decision: "wait", reason: "The AI screen didn't answer. It's tried again on the next sync." };
  }
}
