import { appConfig } from "../../app.config";

/** Spend and size caps for background runs, from app.config.ts (agent.background). */
export const background = appConfig.agent.background;

type Usage = { readonly inputTokens: number; readonly cacheReadTokens: number; readonly outputTokens: number; readonly costUsd?: number };

/**
 * Stops a session once it has spent its budget. Background runs have nobody
 * to ask for more, so the next model call fails and the run is reported as
 * over budget. The token cap is a backstop for when no cost is reported.
 */
export const overBudget =
  (maxUsd: number) =>
  ({ total }: { total: Usage }) =>
    (total.costUsd ?? 0) >= maxUsd || total.inputTokens - total.cacheReadTokens >= 3_000_000 || total.outputTokens >= 300_000;
