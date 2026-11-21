"use client";

import clsx from "clsx";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import { appConfig } from "@/app.config";
import { useApp } from "@/components/app-context";

const items = [
  { href: "/settings/profile", label: "Profile", admin: false },
  { href: "/settings/notifications", label: "Notifications", admin: false },
  { href: "/settings/accounts", label: "Email and calendar", admin: false },
  { href: "/settings/team", label: "Team", admin: false },
  { href: "/settings/agent", label: appConfig.agent.name, admin: false },
  { href: "/settings/api", label: "API and MCP", admin: false },
  { href: "/settings/pipelines", label: "Pipelines", admin: true },
  { href: "/settings/services", label: "Services", admin: true },
  { href: "/settings/labels", label: "Labels", admin: true },
  { href: "/settings/fields", label: "Custom fields", admin: true },
  { href: "/settings/email", label: "Email domains", admin: true },
  { href: "/settings/brand", label: "Email and brand", admin: true },
  { href: "/settings/phone", label: "Phone numbers", admin: true },
  { href: "/settings/workspace", label: "Workspace", admin: true },
];

export function SettingsNav() {
  const pathname = usePathname();
  const { isAdmin } = useApp();
  const ref = useRef<HTMLElement>(null);
  // On a phone the sections are one row that scrolls sideways: keep the open one in view.
  useEffect(() => {
    const nav = ref.current;
    const current = nav?.querySelector<HTMLElement>("[aria-current=page]");
    if (!nav || !current || nav.scrollWidth <= nav.clientWidth) return;
    nav.scrollTo({ left: current.offsetLeft - (nav.clientWidth - current.offsetWidth) / 2, behavior: "smooth" });
  }, [pathname]);
  return (
    <nav ref={ref} aria-label="Settings" className="-mx-4 flex gap-1 overflow-x-auto px-4 md:mx-0 md:flex-col md:px-0 [scrollbar-width:none]">
      {items
        .filter((i) => isAdmin || !i.admin)
        .map((i) => (
          <Link
            key={i.href}
            href={i.href}
            aria-current={pathname === i.href ? "page" : undefined}
            className={clsx("shrink-0 rounded-md px-2.5 py-1.5 text-[13.5px] font-medium pointer-coarse:px-3 pointer-coarse:py-2", pathname === i.href ? "bg-accent-soft text-primary" : "text-secondary hover:bg-sunken hover:text-primary")}
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
