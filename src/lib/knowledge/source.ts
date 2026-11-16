import "server-only";
import { ApiFailure } from "@/lib/api/errors";
import { parseKnowledgeEnv, readKnowledge, type KnowledgeEnv, type KnowledgeSource } from "./core";

/**
 * The deployment's knowledge source (src/lib/knowledge/core.ts), read from
 * KNOWLEDGE_API_URL and friends on the server. Set up wrong, it's off, with
 * one warning in the logs and the reason in the endpoint's error.
 */

let warned = false;

export function knowledgeSource(): KnowledgeSource | null {
  const parsed = parseKnowledgeEnv(process.env as KnowledgeEnv);
  if (parsed && "error" in parsed) {
    if (!warned) console.warn(`[knowledge] ${parsed.error}`);
    warned = true;
    return null;
  }
  return parsed;
}

/** Reads one path of the source (GET /api/v1/knowledge, tool get_knowledge). */
export async function fetchKnowledge(path: string) {
  const source = knowledgeSource();
  if (!source) {
    const parsed = parseKnowledgeEnv(process.env as KnowledgeEnv);
    const reason = parsed && "error" in parsed ? parsed.error : "An admin can connect one with KNOWLEDGE_API_URL (see docs/KNOWLEDGE.md).";
    throw new ApiFailure({ status: 404, code: "not_configured", message: `No knowledge source is connected to this CRM. ${reason}` });
  }
  return readKnowledge(source, path);
}
