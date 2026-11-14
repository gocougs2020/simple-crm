"use server";

import { z } from "zod";
import { run, type Result } from "@/lib/action";
import { ActionError, actionUser } from "@/lib/auth";
import { redirectWith } from "@/lib/oauth/core";
import { checkAuthorizationRequest, issueCode } from "@/lib/oauth/server";
import { siteOrigin } from "@/lib/origin";
import { roleCan } from "@/lib/permissions";

const params = z.record(z.string(), z.string().max(4000));

/**
 * The teammate's answer on the consent page. The request is checked again
 * here (never trusted from the page), and the access is capped by their role
 * and by what the app asked for. Returns where to send the browser: back to
 * the app with a code, or with access_denied.
 */
export async function decideAuthorization(input: Record<string, string>, approve: boolean, readOnly: boolean): Promise<Result<{ url: string }>> {
  return run(async () => {
    const user = await actionUser();
    const origin = await siteOrigin();
    const check = await checkAuthorizationRequest(params.parse(input), origin);
    if (!check.ok) throw new ActionError(check.message);
    const req = check.request;
    if (!approve) return { url: redirectWith(req.redirectUri, { error: "access_denied", error_description: "The request was declined.", state: req.state, iss: origin }) };
    const finalReadOnly = z.boolean().parse(readOnly) || req.readOnly || !roleCan(user.role, "records:write");
    const code = await issueCode(req, user.id, finalReadOnly);
    return { url: redirectWith(req.redirectUri, { code, state: req.state, iss: origin }) };
  });
}
