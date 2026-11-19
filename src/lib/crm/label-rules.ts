/**
 * Labels, as the agent reads them. Pure, so the chat prompt, the background
 * run's first message and the tests share it. The descriptions are what
 * admins wrote in Settings → Labels.
 */

export type LabelBrief = { name: string; description: string | null; hidden: boolean };

/**
 * The "## Labels" section: each label an admin has described, with what it
 * means. Null when there are none. A label with no description isn't listed:
 * its name alone can come from anywhere (an import, an API call), and only
 * what an admin wrote belongs in the agent's instructions. list_labels still
 * returns those, as data.
 */
export function labelsSection(labels: LabelBrief[]) {
  const described = labels.filter((l) => l.description?.trim());
  if (!described.length) return null;
  return [
    "## Labels",
    "Labels are the tags on people, organizations and clients. An organization's labels carry to everyone at it. What the team means by each one:",
    ...described.map((l) => `- ${l.name}${l.hidden ? " (hidden in the app)" : ""}: ${l.description!.replace(/\s+/g, " ").trim()}`),
    "list_labels has every label, including ones nobody has described yet. Use the team's labels as they are, and add a new one only when the teammate asks for it.",
  ].join("\n");
}
