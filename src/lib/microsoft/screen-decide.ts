import { experimental_decide, type Experimental_DecisionModel } from "ai";
import { keepsOut, screenQuestion, screenState } from "./screen-prompt";

/**
 * One email through a decision model: "is this sensitive?", answered with a
 * probability. No server-only imports, so tests can run it against a mock model.
 */

export type ScreenResult = {
  decision: "import" | "withhold";
  /** In words, for Settings and the synced_emails row. */
  reason: string;
  /** Whether the model actually answered. */
  screened: boolean;
  /** Probability the email is sensitive, when screened. */
  score: number | null;
};

export type ScreenEmail = { from: string; to: string[]; subject: string | null; text: string; ourTeam?: string[] };

/** Asks the model. Anything that goes wrong lets the email in, unscreened: Outlook's own Private/Confidential labels are checked before this. */
export async function decideSensitive(model: Experimental_DecisionModel, m: ScreenEmail, opts: { sensitive: string; workspaceName: string; threshold: number; timeoutMs?: number }): Promise<ScreenResult> {
  try {
    const { answers } = await experimental_decide({
      model,
      state: screenState(m, m.ourTeam),
      questions: { sensitive: screenQuestion(opts.sensitive, opts.workspaceName) },
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    const p = answers.sensitive.probability;
    const pct = Math.round(p * 100);
    return keepsOut(p, opts.threshold)
      ? { decision: "withhold", reason: `Looked sensitive (${pct}% likely)`, screened: true, score: p }
      : { decision: "import", reason: `Screened (${pct}% likely sensitive)`, screened: true, score: p };
  } catch (err) {
    console.error("[microsoft] screen", err);
    return { decision: "import", reason: "Not screened: the screen didn't answer", screened: false, score: null };
  }
}
