"use client";

import clsx from "clsx";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useApp } from "@/components/app-context";

export function EmailTabs() {
  const pathname = usePathname();
  const { comms } = useApp();
  const tabs = [
    { href: "/email", label: "Inbox", active: pathname === "/email" },
    // Only their own connected mailbox, and only for them.
    ...(comms.outlook ? [{ href: "/email/outlook", label: "My Outlook", active: pathname.startsWith("/email/outlook") }] : []),
    { href: "/email/campaigns", label: "Campaigns", active: pathname.startsWith("/email/campaigns") },
    { href: "/email/audiences", label: "Audiences", active: pathname.startsWith("/email/audiences") },
    { href: "/email/templates", label: "Templates", active: pathname.startsWith("/email/templates") },
  ];
  return (
    <nav className="flex gap-1 border-b border-line px-4 lg:px-6" aria-label="Email">
      {tabs.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.active ? "page" : undefined}
          className={clsx("-mb-px border-b-2 px-2.5 py-2.5 text-[13.5px] font-medium", t.active ? "border-accent text-primary" : "border-transparent text-muted hover:text-secondary")}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
