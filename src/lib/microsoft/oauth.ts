import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { MICROSOFT_SCOPES, microsoftCredentials } from "./config";
import { GraphError, requestTokens, tokenColumns } from "./graph";

/**
 * Connecting a teammate's Microsoft account: the authorization code flow
 * with PKCE. The state and the PKCE verifier travel in an encrypted,
 * short-lived, HttpOnly cookie, so the callback only accepts the sign-in this
 * browser started, for the teammate who started it.
 */

export const OAUTH_COOKIE = "crm_ms_oauth";
const TEN_MINUTES = 10 * 60_000;

export const callbackPath = "/api/integrations/microsoft/callback";

type Pending = { state: string; verifier: string; userId: string; at: number };

export function startConnect(userId: string, origin: string, loginHint?: string) {
  const creds = microsoftCredentials();
  if (!creds) throw new GraphError("Microsoft 365 isn't set up on this deployment.", 404);
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(`${creds.authority}/authorize`);
  url.search = new URLSearchParams({
    client_id: creds.clientId,
    response_type: "code",
    redirect_uri: `${origin}${callbackPath}`,
    response_mode: "query",
    scope: MICROSOFT_SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
    ...(loginHint ? { login_hint: loginHint } : {}),
  }).toString();
  const cookie = encryptSecret(JSON.stringify({ state, verifier, userId, at: Date.now() } satisfies Pending));
  return { url: url.toString(), cookie };
}

/** Checks the callback against the cookie, exchanges the code, and saves the connection. */
export async function finishConnect(input: { userId: string; origin: string; cookie: string | undefined; code: string | null; state: string | null }) {
  if (!input.cookie || !input.code || !input.state) throw new GraphError("The Microsoft sign-in expired. Start again from Settings.", 400);
  let pending: Pending;
  try {
    pending = JSON.parse(decryptSecret(input.cookie)) as Pending;
  } catch {
    throw new GraphError("The Microsoft sign-in expired. Start again from Settings.", 400);
  }
  if (pending.state !== input.state || pending.userId !== input.userId || Date.now() - pending.at > TEN_MINUTES) {
    throw new GraphError("That Microsoft sign-in wasn't started here, or took too long. Start again from Settings.", 400);
  }
  const tokens = await requestTokens({ grant_type: "authorization_code", code: input.code, redirect_uri: `${input.origin}${callbackPath}`, code_verifier: pending.verifier });

  const meRes = await fetch("https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName", { headers: { authorization: `Bearer ${tokens.access_token}` }, cache: "no-store" });
  const me = (await meRes.json().catch(() => null)) as { id?: string; displayName?: string; mail?: string | null; userPrincipalName?: string } | null;
  if (!meRes.ok || !me?.id) throw new GraphError("Microsoft signed you in but wouldn't share your profile. Try again.", meRes.status);
  const email = (me.mail || me.userPrincipalName || "").toLowerCase();
  if (!email.includes("@")) throw new GraphError("That Microsoft account has no mailbox. Connect a work account with Outlook.", 400);

  const granted = new Set((tokens.scope ?? "").split(" ").map((s) => s.toLowerCase()));
  const missing = ["mail.send", "mail.readwrite", "calendars.readwrite"].filter((s) => granted.size && ![...granted].some((g) => g.endsWith(s)));
  const db = await getDb();
  const t = schema.connectedAccounts;
  const [existing] = await db.select().from(t).where(and(eq(t.userId, input.userId), eq(t.provider, "microsoft")));
  const cols = tokenColumns(tokens);
  const values = {
    ...cols,
    externalId: me.id,
    email,
    name: me.displayName ?? null,
    status: "active" as const,
    lastError: missing.length ? `Microsoft didn't grant ${missing.join(", ")}. Ask your Microsoft admin to approve the app.` : null,
    updatedAt: new Date(),
  };
  if (existing) {
    // Another mailbox starts its sync over; the same one carries on where it was.
    await db
      .update(t)
      .set({ ...values, ...(existing.externalId !== me.id ? { mailCursor: {}, lastSyncAt: null } : {}) })
      .where(eq(t.id, existing.id));
  } else {
    await db.insert(t).values({ ...values, userId: input.userId, provider: "microsoft" });
  }
  return { email };
}
