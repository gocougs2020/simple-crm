import "server-only";
import type { User } from "@/lib/auth";
import { ForbiddenError } from "@/lib/errors";
import { forbiddenMessage, roleCan, type Permission } from "@/lib/permissions";

/**
 * Who is making a change. Every service function takes one, so the browser,
 * the REST API and MCP share the same rules and write the same history.
 * - A teammate in the browser, or through their personal key (`keyId` set).
 * - A workspace key: full access, no teammate behind it.
 */
export type Actor = { kind: "user"; user: User; keyId: string | null } | { kind: "workspace"; keyId: string; keyName: string };

export const sessionActor = (user: User): Actor => ({ kind: "user", user, keyId: null });

/** The teammate to attribute work to, or null for a workspace key. */
export const actorUserId = (a: Actor) => (a.kind === "user" ? a.user.id : null);

export function can(a: Actor, permission: Permission) {
  return a.kind === "workspace" || roleCan(a.user.role, permission);
}

export function assertCan(a: Actor, permission: Permission) {
  if (!can(a, permission)) throw new ForbiddenError(forbiddenMessage[permission]);
}

/** The author fields for history entries and activities. */
export const stamp = (a: Actor) => ({ userId: actorUserId(a), apiKeyId: a.keyId });
