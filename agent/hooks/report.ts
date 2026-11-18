import { failure, reply, usage } from "eve/events";
import { defineHook, type HookContext } from "eve/hooks";
import { crmToken, protectionBypass, runOf } from "../lib/run";

/**
 * Tells the CRM how a run went: its answer, whether it failed, and what it
 * has cost so far (the researcher's spend included). The CRM saves the answer
 * where the teammate asked for it and counts the cost against the month's
 * budget (src/lib/agent/runs.ts).
 */
type Report = { status: "done" | "failed" | "cancelled"; result?: string; error?: string };

async function send(ctx: HookContext, report: Report) {
  const run = runOf(ctx.session.auth.initiator);
  if (!run) return;
  const { total } = usage(ctx.view);
  const response = await fetch(`${run.origin}/api/agent/runs/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await crmToken(run, "report", 120)}`, ...protectionBypass() },
    body: JSON.stringify({
      ...report,
      sessionId: ctx.session.id,
      usage: { costUsd: total.costUsd ?? null, inputTokens: total.inputTokens, outputTokens: total.outputTokens },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`The CRM answered ${response.status} to a run report.`);
}

/** A failed report must not fail the run: the CRM's own check (the agent cron) catches up later. */
const quietly = (work: Promise<void>) => work.catch((err) => console.error("[report]", err));

export default defineHook({
  events: {
    async "turn.settled"(event, ctx) {
      const { turnId, outcome } = event.data;
      if (outcome === "completed") {
        const text = reply(ctx.view, turnId)
          .filter((part) => part.kind === "text" && typeof part.value === "string")
          .map((part) => part.value as string)
          .join("\n\n")
          .trim();
        return quietly(send(ctx, { status: "done", result: text }));
      }
      const error = failure(ctx.view, turnId) ?? event.data.error;
      return quietly(send(ctx, { status: outcome === "cancelled" ? "cancelled" : "failed", error: error ? `${error.code}: ${error.message}` : undefined }));
    },
    async "session.ended"(event, ctx) {
      const error = failure(ctx.view);
      if (error) return quietly(send(ctx, { status: "failed", error: `${error.code}: ${error.message}` }));
    },
  },
});
