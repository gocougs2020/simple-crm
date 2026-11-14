import type { Permission } from "@/lib/permissions";

/** How the docs and OpenAPI describe what each operation needs. */
export const permissionLabels: Record<Permission, string> = {
  "records:read": "any key (every role can read)",
  "records:write": "a workspace key, or a personal key for an owner, admin or member",
  "records:archive": "a workspace key, or a personal key for an owner, admin or member",
  "activities:moderate": "a workspace key, or a personal key for an owner or admin",
  "workspace:admin": "a workspace key, or a personal key for an owner or admin",
};
