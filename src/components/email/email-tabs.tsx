"use client";

import clsx from "clsx";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function EmailTabs() {
  const pathname = usePathname();
  const tabs = [
    { href: "/email", label: "Campaigns", active: pathname === "/email" || pathname.startsWith("/email/campaigns") },
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
