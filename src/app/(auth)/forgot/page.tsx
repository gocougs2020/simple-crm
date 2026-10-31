import type { Metadata } from "next";
import Link from "next/link";
import { AuthFrame } from "@/components/auth/auth-frame";
import { ForgotForm } from "@/components/auth/forms";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPage() {
  return (
    <AuthFrame
      title="Reset your password"
      description="We'll email you a link to choose a new one."
      footer={
        <Link href="/sign-in" className="hover:text-primary hover:underline">
          Back to sign in
        </Link>
      }
    >
      <ForgotForm />
    </AuthFrame>
  );
}
