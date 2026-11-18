import { defineAgent } from "eve";
import { background, overBudget } from "./lib/limits";

/**
 * The assistant's background worker: it does long jobs for a teammate
 * (research, cleanups, follow-ups) after they've closed the chat. It has no
 * shell, no files and no web access of its own. It changes the CRM only
 * through the CRM's MCP tools, as the teammate who asked (connections/crm.ts),
 * and sends web research to the researcher subagent, which can't change anything.
 */
export default defineAgent({
  model: background.model,
  reasoning: background.reasoning,
  // No bash, file or web tools: nothing here needs a sandbox.
  defaultTools: false,
  // No copies of itself: delegation goes to the researcher only.
  tool: false,
  limits: {
    sessionUsage: overBudget(background.maxRunUsd),
    // A finished run's session is kept for a day, then closed.
    sessionTimeoutMs: 24 * 60 * 60 * 1_000,
  },
});
