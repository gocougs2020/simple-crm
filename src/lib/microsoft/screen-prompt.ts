/**
 * What the mail screen asks the decision model: one yes/no question about
 * one email. Pure, so tests can check exactly what the model is given.
 *
 * The email goes in as structured state (separate fields, not a prompt), so
 * nothing written in it can pose as part of the question.
 */

const MAX_BODY = 6_000;

/** The email as the decision model's state: headers and the start of the new text. */
export function screenState(m: { from: string; to: string[]; subject: string | null; text: string }) {
  const body = m.text.replace(/\s+\n/g, "\n").trim();
  return {
    from: m.from,
    to: m.to,
    subject: m.subject?.trim() || null,
    body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n[…the rest is cut off]` : body,
  };
}

/** The question: is this email sensitive? `sensitive` is the deployment's own description (`microsoft.screenInstructions`). */
export function screenQuestion(sensitive: string, workspaceName: string) {
  return {
    type: "boolean" as const,
    instructions: `This email is about to be copied onto a contact's record in ${workspaceName}'s CRM, where everyone on the team can read it. Should it stay out of the CRM because it's sensitive?`,
    criteria: {
      true: `Sensitive: ${sensitive.trim()}`,
      false: "Ordinary business correspondence with a client, prospect or partner: scheduling, introductions, proposals, pricing and quotes, contracts being negotiated, questions, updates and follow-ups.",
    },
  };
}

/** Whether a probability of "sensitive" keeps the email out, at the deployment's threshold (clamped to 0–1). */
export function keepsOut(probability: number, threshold: number) {
  const t = Number.isFinite(threshold) ? Math.min(Math.max(threshold, 0), 1) : 0.5;
  return probability >= t;
}
