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

/** How long an answer from the source is reused: published content, read over and over by the agent within a conversation. */
export const KNOWLEDGE_CACHE_MS = 3 * 60_000;
const KNOWLEDGE_CACHE_ENTRIES = 200;
/** At most this much kept in all (an answer can be up to 2 MB). */
const KNOWLEDGE_CACHE_CHARS = 10_000_000;
const answers = new Map<string, { at: number; size: number; value: Awaited<ReturnType<typeof readKnowledge>> }>();
let kept = 0;
const forget = (key: string) => {
  kept -= answers.get(key)?.size ?? 0;
  answers.delete(key);
};

/**
 * Reads one path of the source (GET /api/v1/knowledge, tool get_knowledge).
 * Answers are kept for a few minutes on this server, keyed by the source and
 * the full path and query; failures aren't kept, so a retry asks again.
 */
export async function fetchKnowledge(path: string) {
  const source = knowledgeSource();
  if (!source) {
    const parsed = parseKnowledgeEnv(process.env as KnowledgeEnv);
    const reason = parsed && "error" in parsed ? parsed.error : "An admin can connect one with KNOWLEDGE_API_URL (see docs/KNOWLEDGE.md).";
    throw new ApiFailure({ status: 404, code: "not_configured", message: `No knowledge source is connected to this CRM. ${reason}` });
  }
  const key = `${source.base}\n${path}`;
  const hit = answers.get(key);
  if (hit && Date.now() - hit.at < KNOWLEDGE_CACHE_MS) return hit.value;
  const value = await readKnowledge(source, path);
  const size = typeof value.content === "string" ? value.content.length : JSON.stringify(value.content ?? null).length;
  forget(key);
  if (size <= KNOWLEDGE_CACHE_CHARS / 10) {
    answers.set(key, { at: Date.now(), size, value });
    kept += size;
  }
  // Oldest first out, so it stays small.
  while (answers.size > KNOWLEDGE_CACHE_ENTRIES || kept > KNOWLEDGE_CACHE_CHARS) forget(answers.keys().next().value!);
  return value;
}
