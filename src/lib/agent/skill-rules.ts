import { z } from "zod";
import { agentScopes, agentSkillModes, type AgentScope, type AgentSkillMode } from "@/lib/constants";

/**
 * The rules for the agent's skills. Pure (tested): what a skill may hold,
 * who may change it, and how skills appear in the agent's instructions. The
 * database side is in skills.ts.
 */

export const MAX_SKILL_NAME = 60;
export const MAX_SKILL_DESCRIPTION = 280;
export const MAX_SKILL_INSTRUCTIONS = 20_000;
/** An always-on skill is in every conversation's instructions, so it's kept short and few. */
export const MAX_ALWAYS_INSTRUCTIONS = 4_000;
export const MAX_ALWAYS_SKILLS = 5;
/** Skills one teammate, or the workspace, can have. */
export const MAX_SKILLS = 50;

export const skillInput = z.object({
  name: z.string().trim().min(1, "Name the skill.").max(MAX_SKILL_NAME, `Keep the name under ${MAX_SKILL_NAME} characters.`).describe('A short name, like "Call write-ups".'),
  description: z
    .string()
    .trim()
    .min(1, "Say when the agent should use this skill.")
    .max(MAX_SKILL_DESCRIPTION, `Keep the description under ${MAX_SKILL_DESCRIPTION} characters.`)
    .describe('When to use it, in a sentence the agent matches requests against: "Use when logging a call or writing up a meeting."'),
  instructions: z
    .string()
    .trim()
    .min(1, "Write what the agent should do.")
    .max(MAX_SKILL_INSTRUCTIONS, `Keep the instructions under ${MAX_SKILL_INSTRUCTIONS.toLocaleString("en-US")} characters.`)
    .describe("What to do, step by step, in markdown."),
  mode: z.enum(agentSkillModes).optional().describe('on_demand (the default): read when a request matches the description. always: part of the instructions in every conversation; keep those short.'),
  scope: z.enum(agentScopes).optional().describe("personal (the default): only this teammate's agent uses it. workspace (shared with everyone's agent) can only be set by an admin in Settings."),
  enabled: z.boolean().optional().describe("false pauses the skill without deleting it."),
});
export type SkillInput = z.infer<typeof skillInput>;
export const skillPatch = skillInput.partial();
export type SkillPatch = z.infer<typeof skillPatch>;

/** Why a skill can't be always-on as written, or null when it can. */
export function alwaysRefusal(skill: { mode?: AgentSkillMode; instructions: string }, othersAlwaysOn: number): string | null {
  if (skill.mode !== "always") return null;
  if (skill.instructions.length > MAX_ALWAYS_INSTRUCTIONS) {
    return `A skill that's always on is part of every conversation, so its instructions can be up to ${MAX_ALWAYS_INSTRUCTIONS.toLocaleString("en-US")} characters. Shorten it, or use it only when it's relevant.`;
  }
  if (othersAlwaysOn >= MAX_ALWAYS_SKILLS) return `${MAX_ALWAYS_SKILLS} skills can be always on. Switch another to "when it's relevant" first.`;
  return null;
}

type Who = { id: string; admin: boolean };
type Owned = { scope: AgentScope; userId: string };

/** A teammate sees their own skills and the shared ones; admins see everyone's, so they can share one. */
export const canSeeSkill = (who: Who, s: Owned) => s.scope === "workspace" || s.userId === who.id || who.admin;
/** A teammate changes their own; shared skills, and other teammates', take an admin. */
export const canEditSkill = (who: Who, s: Owned) => who.admin || (s.scope === "personal" && s.userId === who.id);

export type SkillBrief = { id: string; name: string; description: string; mode: AgentSkillMode; instructions: string; scope: AgentScope };

/**
 * The skills section of the agent's instructions: always-on skills in full,
 * the rest by name and description, to be read with `tool` when a request
 * calls for one. Empty when there are none.
 */
export function skillsSection(skills: SkillBrief[], opts: { tool: string; owner: string }) {
  if (!skills.length) return "";
  // Shared skills first: the team's way of working, then the teammate's own.
  const ordered = [...skills].sort((a, b) => Number(b.scope === "workspace") - Number(a.scope === "workspace") || a.name.localeCompare(b.name));
  const always = ordered.filter((s) => s.mode === "always");
  const offered = ordered.filter((s) => s.mode !== "always");
  const lines = [`## Skills`, `Instructions ${opts.owner} or their admins saved for you. Follow them like the teammate's own request; when one conflicts with what they ask for now, do what they ask now.`];
  for (const s of always) lines.push(`\n### ${s.name}\n${s.instructions}`);
  if (offered.length) {
    lines.push(`\n${always.length ? "More skills" : "Skills"}, to read with ${opts.tool} (pass the id) before doing the work one describes, and then follow:`);
    for (const s of offered) lines.push(`- ${s.name} (id ${s.id}): ${s.description}`);
  }
  return lines.join("\n");
}
