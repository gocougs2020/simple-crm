"use client";

import { useState, useTransition } from "react";
import { signOutOtherDevices } from "@/actions/auth";
import { changePassword, updateProfile } from "@/actions/settings";
import { useApp } from "@/components/app-context";
import { PasswordInput } from "@/components/auth/password-input";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { Section } from "./nav";

export function ProfileSettings() {
  const { viewer } = useApp();
  const [name, setName] = useState(viewer.name);
  const [title, setTitle] = useState(viewer.title ?? "");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [pending, start] = useTransition();
  return (
    <>
      <Section title="Profile" description="Your name and title show on everything you log, and in the signature of emails you send.">
        <form
          className="grid gap-4 p-5 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await updateProfile({ name, title: title || null });
              if (r.ok) toast.success("Profile saved");
              else toast.error(r.error);
            });
          }}
        >
          <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} required />}</Field>
          <Field label="Job title" optional>
            {(p) => <Input {...p} value={title} onChange={(e) => setTitle(e.target.value)} />}
          </Field>
          <Field label="Email" hint="Ask an admin to change your sign-in email.">
            {(p) => <Input {...p} value={viewer.email} disabled />}
          </Field>
          <div className="flex items-end justify-end sm:col-span-2">
            <Button type="submit" variant="primary" loading={pending}>
              Save profile
            </Button>
          </div>
        </form>
      </Section>
      <Section title="Password" description="Changing your password signs you out on every other device.">
        <form
          className="grid gap-4 p-5 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await changePassword({ current, next });
              if (!r.ok) return void toast.error(r.error);
              toast.success("Password changed");
              setCurrent("");
              setNext("");
            });
          }}
        >
          <Field label="Current password">{(p) => <PasswordInput {...p} value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />}</Field>
          <Field label="New password" hint="At least 10 characters.">
            {(p) => <PasswordInput {...p} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={10} required />}
          </Field>
          <div className="flex items-center justify-between gap-3 sm:col-span-2">
            <Button
              variant="ghost"
              onClick={() =>
                start(async () => {
                  await signOutOtherDevices();
                  toast.success("Signed out of every other device");
                })
              }
            >
              Sign out other devices
            </Button>
            <Button type="submit" variant="primary" loading={pending}>
              Change password
            </Button>
          </div>
        </form>
      </Section>
    </>
  );
}
