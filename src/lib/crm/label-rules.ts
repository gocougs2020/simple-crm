/**
 * Labels, as the agent reads them. Pure, so the chat prompt, the background
 * run's first message and the tests share it. The descriptions are what
 * admins wrote in Settings → Labels.
 */

export type LabelBrief = { name: string; description: string | null; hidden: boolean };

/** The "## Labels" section: every label with what it means. Null when there are none. */
export function labelsSection(labels: LabelBrief[]) {
  if (!labels.length) return null;
  return [
    "## Labels",
    "Labels are the tags on people, organizations and clients. An organization's labels carry to everyone at it. What the team means by each one:",
    ...labels.map((l) => `- ${l.name}${l.hidden ? " (hidden in the app)" : ""}: ${l.description?.replace(/\s+/g, " ").trim() || "no description yet"}`),
    "Use these labels as they are. Add a new one only when the teammate asks for it.",
  ].join("\n");
}
