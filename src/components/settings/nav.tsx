"use client";

import clsx from "clsx";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useApp } from "@/components/app-context";

const items = [
  { href: "/settings/profile", label: "Profile", admin: false },
  { href: "/settings/team", label: "Team", admin: false },
  { href: "/settings/pipelines", label: "Pipelines", admin: true },
  { href: "/settings/services", label: "Services", admin: true },
  { href: "/settings/fields", label: "Custom fields", admin: true },
  { href: "/settings/email", label: "Email domains", admin: true },
  { href: "/settings/brand", label: "Email and brand", admin: true },
  { href: "/settings/workspace", label: "Workspace", admin: true },
];

export function SettingsNav() {
  const pathname = usePathname();
  const { isAdmin } = useApp();
  return (
    <nav aria-label="Settings" className="flex gap-1 overflow-x-auto md:flex-col [scrollbar-width:none]">
      {items
        .filter((i) => isAdmin || !i.admin)
        .map((i) => (
          <Link
            key={i.href}
            href={i.href}
            aria-current={pathname === i.href ? "page" : undefined}
            className={clsx("shrink-0 rounded-md px-2.5 py-1.5 text-[13.5px] font-medium", pathname === i.href ? "bg-accent-soft text-primary" : "text-secondary hover:bg-sunken hover:text-primary")}
          >
            {i.label}
          </Link>
        ))}
    </nav>
  );
}

/** A settings section: heading, one line of explanation, then the controls in a card. */
export function Section({ title, description, children, action }: { title: string; description?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-section">{title}</h2>
          {description ? <p className="mt-0.5 max-w-xl text-[13px] text-muted">{description}</p> : null}
        </div>
        {action}
      </div>
      <div className="rounded-xl border border-line bg-surface">{children}</div>
    </section>
  );
}
