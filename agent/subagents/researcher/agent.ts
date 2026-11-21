import { defineAgent } from "eve";
import { background, overBudget } from "../../lib/limits";

/**
 * Reads the public web and reports back. It has web search and fetch and
 * nothing else: no CRM connection, no shell, no files. Whatever a page says,
 * this agent can't change a record; the parent decides what to save.
 */
export default defineAgent({
  description:
    "Researches a company or person on the public web: what they do, size, location, leadership and other people with titles, public contact details, recent news. Give it everything it needs in the message (names, website, what to find); it can't see the CRM or this conversation. Returns findings with source links. It can't change anything.",
  model: background.researchModel,
  reasoning: background.researchReasoning,
  defaultTools: false,
  limits: { sessionUsage: overBudget(background.maxRunUsd) },
});
