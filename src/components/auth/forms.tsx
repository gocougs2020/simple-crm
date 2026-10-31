"use client";

import Link from "next/link";
import { useActionState } from "react";
import { requestPasswordReset, setPassword, setupWorkspace, signIn, type AuthState } from "@/actions/auth";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { FormError } from "./auth-frame";
import { PasswordInput } from "./password-input";

export function SignInForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState(signIn, {} as AuthState);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next ?? ""} />
      <FormError message={state.error} />
      <Field label="Email">{(p) => <Input {...p} name="email" type="email" autoComplete="username" required defaultValue={state.email} autoFocus />}</Field>
      <Field
        label={
          <span className="flex items-center justify-between">
            Password
            <Link href="/forgot" className="text-[12px] font-normal text-muted hover:text-primary hover:underline">
              Forgot password?
            </Link>
          </span>
        }
      >
        {(p) => <PasswordInput {...p} name="password" autoComplete="current-password" required />}
      </Field>
      <Button type="submit" variant="primary" size="lg" loading={pending} className="mt-1 w-full">
        Sign in
      </Button>
    </form>
  );
}

export function SetupForm() {
  const [state, action, pending] = useActionState(setupWorkspace, {} as AuthState);
  return (
    <form action={action} className="flex flex-col gap-4">
      <FormError message={state.error} />
      <Field label="Company name">{(p) => <Input {...p} name="workspace" required autoFocus placeholder="Acme Inc." autoComplete="organization" />}</Field>
      <Field label="Your name">{(p) => <Input {...p} name="name" required autoComplete="name" />}</Field>
      <Field label="Work email">{(p) => <Input {...p} name="email" type="email" required autoComplete="username" defaultValue={state.email} />}</Field>
      <Field label="Password" hint="At least 10 characters. A short phrase is easier to remember.">
        {(p) => <PasswordInput {...p} name="password" required minLength={10} autoComplete="new-password" />}
      </Field>
      <Button type="submit" variant="primary" size="lg" loading={pending} className="mt-1 w-full">
        Create workspace
      </Button>
    </form>
  );
}

export function ForgotForm() {
  const [state, action, pending] = useActionState(requestPasswordReset, {} as AuthState);
  if (state.sent)
    return (
      <div className="text-[14px] text-secondary" role="status">
        <p>
          If <strong className="font-medium text-primary">{state.email}</strong> has an account, a reset link is on its way. It expires in 1 hour.
        </p>
        <p className="mt-3 text-muted">Nothing after a few minutes? Check your spam folder, or ask an admin to send you a new invite.</p>
      </div>
    );
  return (
    <form action={action} className="flex flex-col gap-4">
      <FormError message={state.error} />
      <Field label="Email">{(p) => <Input {...p} name="email" type="email" required autoComplete="username" defaultValue={state.email} autoFocus />}</Field>
      <Button type="submit" variant="primary" size="lg" loading={pending} className="w-full">
        Email me a reset link
      </Button>
    </form>
  );
}

export function SetPasswordForm({ token, kind, name }: { token: string; kind: "invite" | "reset"; name?: string }) {
  const [state, action, pending] = useActionState(setPassword.bind(null, kind), {} as AuthState);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      <FormError message={state.error} />
      {kind === "invite" ? <Field label="Your name">{(p) => <Input {...p} name="name" required defaultValue={name} autoComplete="name" />}</Field> : null}
      <Field label="New password" hint="At least 10 characters.">
        {(p) => <PasswordInput {...p} name="password" required minLength={10} autoComplete="new-password" autoFocus={kind === "reset"} />}
      </Field>
      <Field label="Confirm password">{(p) => <PasswordInput {...p} name="confirm" required minLength={10} autoComplete="new-password" />}</Field>
      <Button type="submit" variant="primary" size="lg" loading={pending} className="mt-1 w-full">
        {kind === "invite" ? "Join the team" : "Save password and sign in"}
      </Button>
    </form>
  );
}
