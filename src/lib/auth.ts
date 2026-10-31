import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { jwtVerify, SignJWT } from "jose";
import { and, eq, gt, isNull, lt, ne } from "drizzle-orm";
import { getDb, schema } from "@/db";

import { SESSION_COOKIE } from "./session-cookie";
const SESSION_DAYS = 30;

function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value) {
    if (process.env.VERCEL) throw new Error("AUTH_SECRET is not set. Generate one with `openssl rand -base64 32`.");
    return new TextEncoder().encode("local-development-secret-change-me");
  }
  return new TextEncoder().encode(value);
}

export type User = typeof schema.users.$inferSelect;
/** What the browser may know about the signed-in teammate. */
export type Viewer = Pick<User, "id" | "name" | "email" | "role" | "title" | "prefs">;

export async function createSession(userId: string) {
  const db = await getDb();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  const userAgent = (await headers()).get("user-agent")?.slice(0, 300) ?? null;
  const [row] = await db.insert(schema.sessions).values({ userId, expiresAt, userAgent }).returning({ id: schema.sessions.id });
  // Housekeeping: drop this user's expired sessions.
  await db.delete(schema.sessions).where(and(eq(schema.sessions.userId, userId), lt(schema.sessions.expiresAt, new Date())));
  await db.update(schema.users).set({ lastSeenAt: new Date() }).where(eq(schema.users.id, userId));

  const token = await new SignJWT({ sid: row.id }).setProtectedHeader({ alg: "HS256" }).setSubject(userId).setIssuedAt().setExpirationTime(`${SESSION_DAYS}d`).sign(secret());
  (await cookies()).set(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DAYS * 86400,
  });
}

/** Signs this browser out: deletes its session row on the server, then the cookie. */
export async function destroySession() {
  const claims = await readSessionCookie();
  if (claims) {
    const db = await getDb();
    await db.delete(schema.sessions).where(eq(schema.sessions.id, claims.sid));
  }
  (await cookies()).delete(SESSION_COOKIE);
}

/** Signs a teammate out on every device. Used on deactivation, password change and "Sign out everywhere". */
export async function revokeSessions(userId: string, exceptSessionId?: string) {
  const db = await getDb();
  const t = schema.sessions;
  await db.delete(t).where(exceptSessionId ? and(eq(t.userId, userId), ne(t.id, exceptSessionId)) : eq(t.userId, userId));
}

/** Verifies the cookie's signature and expiry only. Callers must also check the session row. */
async function readSessionCookie() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    if (!payload.sub || typeof payload.sid !== "string") return null;
    return { userId: payload.sub, sid: payload.sid };
  } catch {
    return null;
  }
}

/**
 * The signed-in, active teammate for this request, or null. Checks the
 * session row on every request, so signing out (or being deactivated) takes
 * effect immediately. Cached per request: layouts and pages share one lookup.
 */
export const getUser = cache(async (): Promise<(User & { sessionId: string }) | null> => {
  await connection();
  const claims = await readSessionCookie();
  if (!claims) return null;
  const db = await getDb();
  const [row] = await db
    .select({ user: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(
      and(
        eq(schema.sessions.id, claims.sid),
        eq(schema.sessions.userId, claims.userId),
        gt(schema.sessions.expiresAt, new Date()),
        isNull(schema.users.deactivatedAt),
      ),
    )
    .limit(1);
  return row ? { ...row.user, sessionId: claims.sid } : null;
});

/** For pages and layouts: sends signed-out visitors to sign in, then back here. */
export async function requireUser(next?: string) {
  const user = await getUser();
  if (!user) redirect(next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in");
  return user;
}

export const isAdmin = (u: Pick<User, "role">) => u.role === "owner" || u.role === "admin";

/** For admin-only pages. Members get a 404, so settings they can't use aren't advertised. */
export async function requireAdminPage() {
  const user = await requireUser();
  if (!isAdmin(user)) notFound();
  return user;
}

/** Thrown inside server actions; the action wrapper turns it into a message. */
export class ActionError extends Error {}

/** For server actions and route handlers. Every exported action must call this (or `actionAdmin`) first. */
export async function actionUser() {
  const user = await getUser();
  if (!user) throw new ActionError("Your session ended. Sign in again to continue.");
  return user;
}

export async function actionAdmin() {
  const user = await actionUser();
  if (!isAdmin(user)) throw new ActionError("Only admins can do that.");
  return user;
}

export function toViewer(u: User): Viewer {
  return { id: u.id, name: u.name, email: u.email, role: u.role, title: u.title, prefs: u.prefs };
}

export async function hashToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Buffer.from(digest).toString("hex");
}

export function randomToken(bytes = 32) {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

/**
 * Only same-site paths are allowed after sign-in. The path is parsed the way
 * the browser will parse it, so tricks like `/\t/evil.com` or `//evil.com`
 * can't send someone off-site.
 */
export function safeRedirect(path: string | null | undefined, fallback = "/") {
  if (!path || !path.startsWith("/")) return fallback;
  try {
    const base = "https://crm.invalid";
    const url = new URL(path, base);
    if (url.origin !== base) return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}

/** Signed token for the one-click unsubscribe link in campaign emails. The purpose claim keeps it from being reused for anything else. */
export async function signUnsubscribe(personId: string) {
  return new SignJWT({ purpose: "unsubscribe" }).setProtectedHeader({ alg: "HS256" }).setSubject(personId).sign(secret());
}

export async function verifyUnsubscribe(token: string) {
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    return payload.purpose === "unsubscribe" && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}
