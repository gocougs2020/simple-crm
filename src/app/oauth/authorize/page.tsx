import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthFrame } from "@/components/auth/auth-frame";
import { ConsentForm } from "@/components/oauth/consent";
import { requireUser } from "@/lib/auth";
import { roleLabels } from "@/lib/constants";
import { redirectLabel } from "@/lib/oauth/core";
import { checkAuthorizationRequest } from "@/lib/oauth/server";
import { siteOrigin } from "@/lib/origin";
import { roleCan } from "@/lib/permissions";
import { getWorkspace } from "@/lib/workspace";

export const metadata: Metadata = { title: "Connect an app" };

/**
 * OAuth consent: an agent (Claude, ChatGPT…) asks to act as the signed-in
 * teammate. Signed-out visitors sign in first and come back here.
 */
export default function AuthorizePage({ searchParams }: PageProps<"/oauth/authorize">) {
  return (
    <Suspense fallback={<main className="min-h-dvh bg-canvas" />}>
      <Consent searchParams={searchParams} />
    </Suspense>
  );
}

async function Consent({ searchParams }: Pick<PageProps<"/oauth/authorize">, "searchParams">) {
  const raw = await searchParams;
  const params = Object.fromEntries(Object.entries(raw).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));
  const user = await requireUser(`/oauth/authorize?${new URLSearchParams(params)}`);
  const [ws, origin] = await Promise.all([getWorkspace(), siteOrigin()]);
  const check = await checkAuthorizationRequest(params, origin);
  if (!check.ok) {
    return (
      <AuthFrame workspace={ws.name} title="This link doesn't work" description={check.message}>
        <p className="text-[13.5px] text-muted">Nothing was shared. You can close this tab.</p>
      </AuthFrame>
    );
  }
  const req = check.request;
  return (
    <AuthFrame workspace={ws.name} title={`Connect ${req.client.name}`} description={`${req.client.name} wants to work in ${ws.name} as you.`}>
      <ConsentForm
        params={params}
        appName={req.client.name}
        returnTo={redirectLabel(req.redirectUri)}
        userName={user.name}
        roleLabel={roleLabels[user.role]}
        canWrite={roleCan(user.role, "records:write")}
        askedReadOnly={req.readOnly}
      />
    </AuthFrame>
  );
}
