import type { UserRole } from "@/lib/constants";

/**
 * What each role may do. One table for the interface, the REST API and MCP,
 * so a personal API key or an agent can never do more than its teammate can
 * in the browser. Pure (no server imports) so client components can hide
 * controls with the same rules the server enforces.
 */
export const permissions = [
  /** See people, organizations, clients, activities, pipelines and the team. */
  "records:read",
  /** Create and edit records, log activity, add tasks and notes, move clients. */
  "records:write",
  /** Archive and restore records. */
  "records:archive",
  /** Edit or delete activity someone else logged. */
  "activities:moderate",
  /** Settings, pipelines, fields, services, the team and workspace API keys. */
  "workspace:admin",
] as const;
export type Permission = (typeof permissions)[number];

const grants: Record<UserRole, readonly Permission[]> = {
  owner: permissions,
  admin: permissions,
  member: ["records:read", "records:write", "records:archive"],
  viewer: ["records:read"],
};

export function roleCan(role: UserRole, permission: Permission) {
  return (grants[role] ?? []).includes(permission);
}

export function rolePermissions(role: UserRole): Permission[] {
  return [...(grants[role] ?? [])];
}

/** The sentence shown when someone's role doesn't allow an action. */
export const forbiddenMessage: Record<Permission, string> = {
  "records:read": "Your access doesn't include reading records.",
  "records:write": "Your role can view records but not change them. Ask an admin for edit access.",
  "records:archive": "Your role can't archive records. Ask an admin for edit access.",
  "activities:moderate": "Only the person who logged this, or an admin, can change it.",
  "workspace:admin": "Only admins can do that.",
};
