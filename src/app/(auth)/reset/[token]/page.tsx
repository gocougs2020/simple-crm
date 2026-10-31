import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AuthFrame } from "@/components/auth/auth-frame";
import { SetPasswordForm } from "@/components/auth/forms";
import { peekToken } from "@/lib/auth-tokens";
import { getWorkspace } from "@/lib/workspace";

export const metadata: Metadata = { title: "Reset password" };

export default function Page({ params }: PageProps<"/reset/[token]">) {
  return (
    <Suspense fallback={<main className="min-h-dvh bg-canvas" />}>
      <Content params={params} />
    </Suspense>
  );
}

async function Content({ params }: Pick<PageProps<"/reset/[token]">, "params">) {
  const { token } = await params;
  const [who, ws] = await Promise.all([peekToken(token, "reset"), getWorkspace()]);
  if (!who)
    return (
      <AuthFrame workspace={ws.name} title="This link has expired" description="Links work once and expire after a while.">
        <p className="text-[14px] text-secondary"><Link href="/forgot" className="font-medium text-primary underline underline-offset-2">Request a new reset link</Link>, or sign in if you already changed it.</p>
      </AuthFrame>
    );
  return (
    <AuthFrame workspace={ws.name} title={"Choose a new password"} description={`For ${who.email}`}>
      <SetPasswordForm token={token} kind="reset" name={who.name} />
    </AuthFrame>
  );
}
