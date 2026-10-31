"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { addSampleData, updateWorkspace } from "@/actions/settings";
import { useApp } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { Section } from "./nav";

const currencies = ["USD", "CAD", "EUR", "GBP", "AUD", "NZD", "MXN", "JPY", "INR", "CHF", "SEK", "BRL", "ZAR", "SGD"];

export function WorkspaceSettings({ canAddSample }: { canAddSample: boolean }) {
  const { workspace } = useApp();
  const router = useRouter();
  const [name, setName] = useState(workspace.name);
  const [currency, setCurrency] = useState(workspace.currency);
  const [timezone, setTimezone] = useState(workspace.timezone);
  const [pending, start] = useTransition();
  const zones = useMemo(() => Intl.supportedValuesOf("timeZone"), []);
  return (
    <>
      <Section title="Workspace" description="The time zone decides what “today” and “overdue” mean for the whole team.">
        <form
          className="grid gap-4 p-5 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await updateWorkspace({ name, currency, timezone });
              if (r.ok) toast.success("Workspace saved");
              else toast.error(r.error);
            });
          }}
        >
          <Field label="Company name" className="sm:col-span-2">
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} required />}
          </Field>
          <Field label="Currency" hint="New deals use this currency.">
            {(p) => (
              <Select id={p.id} value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {currencies.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Time zone">
            {(p) => (
              <Select id={p.id} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z.replace(/_/g, " ")}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="flex justify-end sm:col-span-2">
            <Button type="submit" variant="primary" loading={pending}>
              Save
            </Button>
          </div>
        </form>
      </Section>
      {canAddSample ? (
        <Section title="Sample data" description="Local development only. Adds a few organizations, people, deals and activities so you can try things out.">
          <div className="p-5">
            <Button
              variant="outline"
              loading={pending}
              onClick={() =>
                start(async () => {
                  const r = await addSampleData();
                  if (!r.ok) return void toast.error(r.error);
                  toast.success(`Added ${r.data.people} people with their organizations, deals and activity`);
                  router.push("/deals");
                })
              }
            >
              Add sample data
            </Button>
          </div>
        </Section>
      ) : null}
    </>
  );
}
