import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AuthFrame } from "@/components/auth/auth-frame";
import { SetupForm } from "@/components/auth/forms";
import { needsSetup } from "@/lib/auth-tokens";

export const metadata: Metadata = { title: "Set up your workspace" };

/** Shown once, on a fresh database. The person who fills it in becomes the owner. */
export default function SetupPage() {
  return (
    <Suspense fallback={<main className="min-h-dvh bg-canvas" />}>
      <Setup />
    </Suspense>
  );
}

async function Setup() {
  if (!(await needsSetup())) redirect("/sign-in");
  return (
    <AuthFrame title="Set up your CRM" description="Create the owner account. You'll invite your team next.">
      <SetupForm />
    </AuthFrame>
  );
}
