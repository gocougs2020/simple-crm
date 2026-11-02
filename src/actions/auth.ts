"use server";

import { redirect } from "next/navigation";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { createSession, destroySession, getUser, hashToken, randomToken, revokeSessions, safeRedirect } from "@/lib/auth";
import { emailBrand } from "@/lib/brand";
import { sendEmail } from "@/lib/email";
import { siteOrigin } from "@/lib/origin";
import { hashPassword, passwordProblem, verifyDecoy, verifyPassword } from "@/lib/password";
import { resetLimitError, signInLimitError } from "@/lib/rate-limit";
import { peekToken } from "@/lib/auth-tokens";
import { clientCategories } from "@/lib/constants";
import { defaultStages } from "@/lib/crm/defaults";
import ResetPasswordEmail from "@/emails/reset-password";

/** Form state for the auth pages. `fields` echoes back what was typed (never the password) so a failed submit doesn't clear the form. */
export type AuthState = { error?: string; sent?: boolean; email?: string };

const email = z.email("Enter a valid email address.").max(200).transform((e) => e.trim().toLowerCase());
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");

export async function signIn(_: AuthState, fd: FormData): Promise<AuthState> {
  const parsed = email.safeParse(str(fd, "email").trim());
  const password = str(fd, "password");
  if (!parsed.success) return { error: "Enter a valid email address.", email: str(fd, "email") };
  if (!password) return { error: "Enter your password.", email: parsed.data };

  const limited = await signInLimitError(parsed.data);
  if (limited) return { error: limited, email: parsed.data };

  const db = await getDb();
  const [user] = await db.select().from(schema.users).where(eq(schema.users.email, parsed.data)).limit(1);
  // The same message (and the same time spent hashing) whether or not the account exists, so the form can't be used to discover emails.
  const ok = user?.passwordHash ? await verifyPassword(password, user.passwordHash) : await verifyDecoy(password);
  if (!user || !ok) return { error: "That email and password don't match. Try again, or reset your password.", email: parsed.data };
  if (user.deactivatedAt) return { error: "Your account has been deactivated. Ask an admin to reactivate it.", email: parsed.data };

  await createSession(user.id);
  redirect(safeRedirect(str(fd, "next")));
}

export async function signOut() {
  await destroySession();
  redirect("/sign-in");
}

/** Ends every other session for the signed-in teammate (lost laptop, shared computer). */
export async function signOutOtherDevices() {
  const user = await getUser();
  if (user) await revokeSessions(user.id, user.sessionId);
}

const setupSchema = z.object({
  workspace: z.string().trim().min(1, "Enter your company's name.").max(80),
  name: z.string().trim().min(1, "Enter your name.").max(80),
  email,
  password: z.string(),
});

/** Creates the first account (the owner) and names the workspace. Only works on an empty database. */
export async function setupWorkspace(_: AuthState, fd: FormData): Promise<AuthState> {
  const parsed = setupSchema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: parsed.error.issues[0].message, email: str(fd, "email") };
  const { workspace, name, email: address, password } = parsed.data;
  const problem = passwordProblem(password, address);
  if (problem) return { error: problem, email: address };

  const db = await getDb();
  const passwordHash = await hashPassword(password);
  // Insert only if no account exists yet, in one statement, so two people racing through setup can't both become owner.
  const rows = await db.execute<{ id: string }>(sql`
    insert into users (email, name, password_hash, role)
    select ${address}, ${name}, ${passwordHash}, 'owner'
    where not exists (select 1 from users)
    returning id`);
  const id = (rows as unknown as { rows?: { id: string }[] }).rows?.[0]?.id ?? (rows as unknown as { id: string }[])[0]?.id;
  if (!id) return { error: "This workspace is already set up. Sign in instead." };

  await db
    .insert(schema.workspace)
    .values({ id: 1, name: workspace })
    .onConflictDoUpdate({ target: schema.workspace.id, set: { name: workspace, updatedAt: new Date() } });
  await seedDefaults();
  await createSession(id);
  redirect("/");
}

/** A first pipeline for each client category so the boards aren't empty on day one. Stages can be renamed or removed in Settings. */
async function seedDefaults() {
  const db = await getDb();
  for (const category of clientCategories) {
    const [existing] = await db.select({ id: schema.pipelines.id }).from(schema.pipelines).where(eq(schema.pipelines.category, category)).limit(1);
    if (existing) continue;
    const d = defaultStages[category];
    const [pipeline] = await db.insert(schema.pipelines).values({ name: d.pipeline, category, position: 0 }).returning();
    await db.insert(schema.stages).values(d.stages.map((s, position) => ({ pipelineId: pipeline.id, name: s.name, probability: s.probability, rottingDays: s.rottingDays, position })));
  }
}

export async function requestPasswordReset(_: AuthState, fd: FormData): Promise<AuthState> {
  const parsed = email.safeParse(str(fd, "email").trim());
  if (!parsed.success) return { error: "Enter a valid email address.", email: str(fd, "email") };
  const limited = await resetLimitError(parsed.data);
  if (limited) return { error: limited, email: parsed.data };

  const db = await getDb();
  const [user] = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.email, parsed.data), isNull(schema.users.deactivatedAt)))
    .limit(1);
  // Same answer either way, so this form can't be used to discover who has an account.
  if (user?.passwordHash) {
    const token = randomToken();
    await db.insert(schema.authTokens).values({ tokenHash: await hashToken(token), kind: "reset", userId: user.id, expiresAt: new Date(Date.now() + 60 * 60_000) });
    try {
      await sendEmail({
        to: user.email,
        subject: "Reset your CRM password",
        react: ResetPasswordEmail({ brand: await emailBrand(), url: `${await siteOrigin()}/reset/${token}` }),
        tags: [{ name: "type", value: "password-reset" }],
      });
    } catch (err) {
      console.error("[auth] reset email", err);
      return { error: "We couldn't send the email. Try again in a moment.", email: parsed.data };
    }
  }
  return { sent: true, email: parsed.data };
}

/**
 * Uses up a link and returns its user. Marking it used and reading it back is
 * one conditional UPDATE, so a link works once even if it's submitted twice
 * at the same moment.
 */
async function consumeToken(token: string, kind: "invite" | "reset") {
  const db = await getDb();
  const t = schema.authTokens;
  const [row] = await db
    .update(t)
    .set({ usedAt: new Date() })
    .where(and(eq(t.tokenHash, await hashToken(token)), eq(t.kind, kind), isNull(t.usedAt), gt(t.expiresAt, new Date())))
    .returning({ userId: t.userId });
  return row?.userId ?? null;
}

const setPasswordSchema = z.object({ token: z.string().min(10), password: z.string(), name: z.string().trim().max(80).optional() });

/** Finishes an invite or a reset: sets the password, signs out every other session, and signs this browser in. */
export async function setPassword(kind: "invite" | "reset", _: AuthState, fd: FormData): Promise<AuthState> {
  const parsed = setPasswordSchema.safeParse(Object.fromEntries(fd));
  if (!parsed.success) return { error: "This link isn't valid. Ask for a new one." };
  const { token, password, name } = parsed.data;
  const pending = await peekToken(token, kind);
  if (!pending) return { error: "This link has expired or was already used. Ask for a new one." };
  if (kind === "invite" && !name) return { error: "Enter your name." };
  const problem = passwordProblem(password, pending.email);
  if (problem) return { error: problem };
  if (str(fd, "confirm") !== password) return { error: "The two passwords don't match." };

  const userId = await consumeToken(token, kind);
  if (!userId) return { error: "This link has expired or was already used. Ask for a new one." };
  const db = await getDb();
  await db
    .update(schema.users)
    .set({ passwordHash: await hashPassword(password), ...(kind === "invite" && name ? { name } : {}) })
    .where(eq(schema.users.id, userId));
  await revokeSessions(userId);
  await createSession(userId);
  redirect("/");
}
