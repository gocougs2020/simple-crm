/**
 * What the mail screen asks the decision model: one yes/no question about
 * one email. Pure, so tests can check exactly what the model is given.
 *
 * The email goes in as structured state (separate fields, not a prompt), so
 * nothing written in it can pose as part of the question.
 */

const MAX_BODY = 6_000;

/**
 * The email as the decision model's state: headers, the start of the new
 * text, and who's on our own team (names and addresses), so the model can
 * tell a conversation between teammates from one with a client.
 */
export function screenState(m: { from: string; to: string[]; subject: string | null; text: string }, ourTeam: string[] = []) {
  const body = m.text.replace(/\s+\n/g, "\n").trim();
  return {
    from: m.from,
    to: m.to,
    subject: m.subject?.trim() || null,
    body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n[…the rest is cut off]` : body,
    ourTeam: ourTeam.slice(0, 200),
  };
}

/** The question: is this email sensitive? `sensitive` is the deployment's own description (`microsoft.screenInstructions`). */
export function screenQuestion(sensitive: string, workspaceName: string) {
  return {
    type: "boolean" as const,
    instructions: `This email is about to be copied onto a contact's record in ${workspaceName}'s CRM, where everyone on the team can read it. Should it stay out of the CRM because it's sensitive?`,
    criteria: {
      true: `Sensitive: ${sensitive.trim()}`,
      false: "Ordinary business correspondence with a client, candidate, prospect or partner about the work: scheduling, introductions, roles and candidates, proposals, our fees and quotes, contracts being negotiated, questions, updates and follow-ups.",
    },
  };
}
