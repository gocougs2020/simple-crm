import "server-only";
import type { User } from "@/lib/auth";
import { ForbiddenError } from "@/lib/errors";
import { forbiddenMessage, roleCan, type Permission } from "@/lib/permissions";

/**
 * Who is making a change. Every service function takes one, so the browser,
 * the REST API and MCP share the same rules and write the same history.
 * - A teammate in the browser, or through a personal key or connected app
 *   (`keyId` set). `readOnly` narrows a key or app to reading, whatever the
 *   teammate's role allows.
 *   `runId` is set while the assistant works in the background for them
 *   (src/lib/agent/runs.ts): the same access, minus what needs a person watching.
 * - A workspace key: full access, no teammate behind it.
 */
export type Actor = { kind: "user"; user: User; keyId: string | null; readOnly?: boolean; runId?: string } | { kind: "workspace"; keyId: string; keyName: string };

export const sessionActor = (user: User): Actor => ({ kind: "user", user, keyId: null });

/** The teammate to attribute work to, or null for a workspace key. */
export const actorUserId = (a: Actor) => (a.kind === "user" ? a.user.id : null);

export function can(a: Actor, permission: Permission) {
  if (a.kind === "workspace") return true;
  if (a.readOnly && permission !== "records:read") return false;
  return roleCan(a.user.role, permission);
}

export function assertCan(a: Actor, permission: Permission) {
  if (can(a, permission)) return;
  if (a.kind === "user" && a.readOnly && roleCan(a.user.role, permission)) {
    throw new ForbiddenError("This key or connected app is read-only. Reconnect it with edit access to make changes.");
  }
  throw new ForbiddenError(forbiddenMessage[permission]);
}

/** The author fields for history entries and activities. */
export const stamp = (a: Actor) => ({ userId: actorUserId(a), apiKeyId: a.keyId });
