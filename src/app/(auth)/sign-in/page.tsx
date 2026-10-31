import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AuthFrame } from "@/components/auth/auth-frame";
import { SignInForm } from "@/components/auth/forms";
import { getUser, safeRedirect } from "@/lib/auth";
import { needsSetup } from "@/lib/auth-tokens";
import { getWorkspace } from "@/lib/workspace";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  return (
    <Suspense fallback={<main className="min-h-dvh bg-canvas" />}>
      <SignIn searchParams={searchParams} />
    </Suspense>
  );
}

async function SignIn({ searchParams }: Pick<PageProps<"/sign-in">, "searchParams">) {
  const { next } = await searchParams;
  const nextPath = typeof next === "string" ? next : undefined;
  if (await needsSetup()) redirect("/setup");
  if (await getUser()) redirect(safeRedirect(nextPath));
  const ws = await getWorkspace();
  return (
    <AuthFrame workspace={ws.name} title="Sign in" description="Welcome back." footer="New to the team? Ask an admin for an invite.">
      <SignInForm next={nextPath} />
    </AuthFrame>
  );
}
