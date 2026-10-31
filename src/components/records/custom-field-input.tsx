"use client";

import type { CustomField } from "@/lib/crm/context";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/field";
import { Tag } from "@/components/ui/badge";

type Value = string | number | boolean | string[] | null | undefined;

/** The right control for a custom field's type. Money is edited in whole units and stored in cents. */
export function CustomFieldInput({ field, value, onChange, id }: { field: CustomField; value: Value; onChange: (v: Value) => void; id?: string }) {
  switch (field.type) {
    case "longtext":
      return <Textarea id={id} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} rows={3} />;
    case "number":
      return <Input id={id} inputMode="decimal" value={value == null ? "" : String(value)} onChange={(e) => onChange(e.target.value)} />;
    case "currency":
      return (
        <Input
          id={id}
          inputMode="decimal"
          placeholder="0"
          value={value == null || value === "" ? "" : typeof value === "number" ? String(value / 100) : String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "date":
      return <Input id={id} type="date" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />;
    case "checkbox":
      return <Checkbox id={id} checked={!!value} onChange={(e) => onChange(e.target.checked)} label={field.label} />;
    case "select":
      return (
        <Select id={id} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {field.options.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </Select>
      );
    case "multiselect": {
      const list = Array.isArray(value) ? value : [];
      return (
        <div className="flex flex-wrap gap-1.5">
          {field.options.map((o) => {
            const on = list.includes(o);
            return (
              <button
                key={o}
                type="button"
                aria-pressed={on}
                onClick={() => onChange(on ? list.filter((x) => x !== o) : [...list, o])}
                className={on ? "rounded-full" : "rounded-full opacity-60 hover:opacity-100"}
              >
                <Tag className={on ? "border-accent bg-accent-soft text-primary" : ""}>{o}</Tag>
              </button>
            );
          })}
        </div>
      );
    }
    case "url":
      return <Input id={id} type="url" placeholder="https://" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />;
    case "email":
      return <Input id={id} type="email" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />;
    case "phone":
      return <Input id={id} type="tel" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />;
    default:
      return <Input id={id} value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value)} />;
  }
}

/** Read-only display of a custom value. */
export function formatCustomValue(field: CustomField, value: Value, money: (c: number) => string): string {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return "";
  switch (field.type) {
    case "currency":
      return typeof value === "number" ? money(value) : String(value);
    case "checkbox":
      return value ? "Yes" : "No";
    case "multiselect":
      return (value as string[]).join(", ");
    case "date": {
      const [y, m, d] = String(value).split("-").map(Number);
      return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
    }
    case "number":
      return new Intl.NumberFormat("en-US").format(Number(value));
    default:
      return String(value);
  }
}
