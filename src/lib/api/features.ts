import "server-only";
import { aiFeatures } from "@/lib/agent/config";
import { KNOWLEDGE_TOOL, knowledgeInstructions, knowledgeToolDescription } from "@/lib/knowledge/core";
import { knowledgeSource } from "@/lib/knowledge/source";
import type { OptionalFeature } from "./spec";

/**
 * The optional parts of the API this deployment has set up. MCP and the
 * assistant offer their tools only when they're on, with descriptions that
 * name what this deployment connected.
 */
export function enabledFeatures(): OptionalFeature[] {
  const features: OptionalFeature[] = [];
  if (knowledgeSource()) features.push("knowledge");
  // The agent's background work (docs/AGENT.md): its tools appear only where it can run.
  if (aiFeatures().background) features.push("background");
  return features;
}

/** A tool's description for this deployment: the knowledge tool names and describes the connected source. */
export function deploymentToolDescription(tool: string, description: string) {
  if (tool !== KNOWLEDGE_TOOL) return description;
  const source = knowledgeSource();
  return source ? knowledgeToolDescription(description, source) : description;
}

/** Extra instructions for agents about what's connected, or null when nothing optional is. */
export function featureInstructions() {
  const source = knowledgeSource();
  return source ? knowledgeInstructions(source) : null;
}
