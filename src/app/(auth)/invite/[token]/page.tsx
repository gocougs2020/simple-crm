import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthFrame } from "@/components/auth/auth-frame";
import { SetPasswordForm } from "@/components/auth/forms";
import { peekToken } from "@/lib/auth-tokens";
import { getWorkspace } from "@/lib/workspace";

export const metadata: Metadata = { title: "Accept invite" };

export default function Page({ params }: PageProps<"/invite/[token]">) {
  return (
    <Suspense fallback={<main className="min-h-dvh bg-canvas" />}>
      <Content params={params} />
    </Suspense>
  );
}

async function Content({ params }: Pick<PageProps<"/invite/[token]">, "params">) {
  const { token } = await params;
  const [who, ws] = await Promise.all([peekToken(token, "invite"), getWorkspace()]);
  if (!who)
    return (
      <AuthFrame workspace={ws.name} title="This link has expired" description="Links work once and expire after a while.">
        <p className="text-[14px] text-secondary">Ask the teammate who invited you to send a new invite from Settings → Team.</p>
      </AuthFrame>
    );
  return (
    <AuthFrame workspace={ws.name} title={`Join ${ws.name}`} description={`Set a password for ${who.email}.`}>
      <SetPasswordForm token={token} kind="invite" name={who.name} />
    </AuthFrame>
  );
}
