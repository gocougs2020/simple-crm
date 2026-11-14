"use server";

import { refresh } from "next/cache";
import { and, count, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { run, type Result } from "@/lib/action";
import { generateKey } from "@/lib/api/key-format";
import { ActionError, actionUser, isAdmin } from "@/lib/auth";
import { endGrant } from "@/lib/oauth/server";
import { manualKeyKinds } from "@/lib/constants";

const { apiKeys } = schema;
const MAX_PERSONAL_KEYS = 10;

const createInput = z.object({
  kind: z.enum(manualKeyKinds),
  name: z.string().trim().min(1, "Name the key after where it's used, like “Claude on my laptop”.").max(60),
  expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365)]).nullable(),
  readOnly: z.boolean().optional(),
});

/**
 * Makes an API key and returns it once; only its hash is kept. Anyone can
 * make personal keys (for MCP and their own scripts), which act as them with
 * their role. Only admins can make workspace keys, which have full access.
 */
export async function createApiKey(input: z.input<typeof createInput>): Promise<Result<{ token: string }>> {
  return run(async () => {
    const user = await actionUser();
    const data = createInput.parse(input);
    if (data.kind === "workspace" && !isAdmin(user)) throw new ActionError("Only admins can create workspace keys.");
    const db = await getDb();
    if (data.kind === "personal") {
      const [{ n }] = await db
        .select({ n: count() })
        .from(apiKeys)
        .where(and(eq(apiKeys.userId, user.id), eq(apiKeys.kind, "personal"), isNull(apiKeys.revokedAt)));
      if (n >= MAX_PERSONAL_KEYS) throw new ActionError(`You have ${MAX_PERSONAL_KEYS} keys already. Revoke one you no longer use first.`);
    }
    const { token, prefix, hash } = generateKey(data.kind);
    await db.insert(apiKeys).values({
      name: data.name,
      kind: data.kind,
      userId: data.kind === "personal" ? user.id : null,
      prefix,
      tokenHash: hash,
      createdBy: user.id,
      expiresAt: data.expiresInDays ? new Date(Date.now() + data.expiresInDays * 86400_000) : null,
      // Workspace keys always have full access; a personal key can be narrowed to reading.
      readOnly: data.kind === "personal" && !!data.readOnly,
    });
    refresh();
    return { token };
  });
}

/** Stops a key or disconnects an app at once. Your own keys and apps, or (for admins) anyone's. */
export async function revokeApiKey(keyId: string): Promise<Result> {
  return run(async () => {
    const user = await actionUser();
    const db = await getDb();
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, z.uuid().parse(keyId)));
    if (!key || key.revokedAt) return;
    const own = key.kind !== "workspace" && key.userId === user.id;
    if (!own && !isAdmin(user)) throw new ActionError("Only admins can revoke someone else's key.");
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, key.id));
    if (key.kind === "oauth") await endGrant(key.id);
    refresh();
  });
}
