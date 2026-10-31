"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import {
  ArrowRightStartOnRectangleIcon,
  Bars3Icon,
  BuildingOffice2Icon,
  CheckCircleIcon,
  Cog6ToothIcon,
  CurrencyDollarIcon,
  EnvelopeIcon,
  FolderIcon,
  HomeIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  UserIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import { signOut } from "@/actions/auth";
import { useApp } from "@/components/app-context";
import { Avatar } from "@/components/ui/avatar";
import { Kbd } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { NextStepDialog } from "@/components/activity/next-step-dialog";
import { CommandPalette, openPalette } from "./command-palette";
import { CreateDialogs } from "./create-dialogs";
import { openCreate } from "./create-store";

type NavItem = { href: string; label: string; icon: ComponentType<{ className?: string }>; badge?: number; tone?: "error" };

export function AppShell({ due, children }: { due: { overdue: number; today: number }; children: ReactNode }) {
  const { viewer, workspace } = useApp();
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- close the mobile drawer after navigating
  useEffect(() => setDrawer(false), [pathname]);

  const nav: NavItem[] = [
    { href: "/", label: "Home", icon: HomeIcon },
    { href: "/deals", label: "Deals", icon: CurrencyDollarIcon },
    { href: "/people", label: "People", icon: UserIcon },
    { href: "/organizations", label: "Organizations", icon: BuildingOffice2Icon },
    { href: "/activities", label: "Activities", icon: CheckCircleIcon, badge: due.overdue + due.today || undefined, tone: due.overdue ? "error" : undefined },
    { href: "/files", label: "Files", icon: FolderIcon },
    { href: "/email", label: "Email", icon: EnvelopeIcon },
  ];

  const sidebar = (
    <nav className="flex h-full flex-col gap-1 px-3 py-4" aria-label="Main">
      <div className="mb-3 flex items-center gap-2 px-2">
        <span className="flex size-7 items-center justify-center rounded-md bg-accent text-[13px] font-semibold text-accent-foreground">{workspace.name.slice(0, 1).toUpperCase()}</span>
        <span className="truncate text-[14px] font-semibold text-primary">{workspace.name}</span>
      </div>
      <button
        type="button"
        onClick={openPalette}
        className="mb-1 flex h-8 items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-[13px] text-muted shadow-sm transition-colors hover:border-line-strong hover:text-secondary"
      >
        <MagnifyingGlassIcon className="size-4" aria-hidden />
        <span className="flex-1 text-left">Search</span>
        <Kbd>⌘K</Kbd>
      </button>
      <Menu>
        <MenuTrigger asChild>
          <button type="button" className="mb-3 flex h-8 items-center gap-2 rounded-md bg-accent px-2.5 text-[13px] font-medium text-accent-foreground shadow-sm hover:bg-accent-hover">
            <PlusIcon className="size-4" aria-hidden />
            New
          </button>
        </MenuTrigger>
        <MenuContent align="start" className="w-52">
          <MenuItem icon={<CurrencyDollarIcon />} onSelect={() => openCreate({ kind: "deal" })}>
            Deal
          </MenuItem>
          <MenuItem icon={<UserIcon />} onSelect={() => openCreate({ kind: "person" })}>
            Person
          </MenuItem>
          <MenuItem icon={<BuildingOffice2Icon />} onSelect={() => openCreate({ kind: "organization" })}>
            Organization
          </MenuItem>
        </MenuContent>
      </Menu>
      {nav.map((n) => {
        const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className={clsx(
              "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13.5px] font-medium transition-colors",
              active ? "bg-accent-soft text-accent-soft-foreground" : "text-secondary hover:bg-sunken hover:text-primary",
            )}
          >
            <n.icon className={clsx("size-[18px]", active ? "text-primary" : "text-muted")} aria-hidden />
            <span className="flex-1">{n.label}</span>
            {n.badge ? (
              <span
                className={clsx("min-w-5 rounded-full px-1.5 text-center text-[11px] leading-5 font-semibold tabular-nums", n.tone === "error" ? "bg-error-surface text-error" : "bg-sunken text-secondary")}
                aria-label={`${n.badge} due`}
              >
                {n.badge}
              </span>
            ) : null}
          </Link>
        );
      })}
      <div className="mt-auto flex flex-col gap-1">
        <Link
          href="/settings"
          className={clsx(
            "flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13.5px] font-medium transition-colors",
            pathname.startsWith("/settings") ? "bg-accent-soft text-primary" : "text-secondary hover:bg-sunken hover:text-primary",
          )}
        >
          <Cog6ToothIcon className="size-[18px] text-muted" aria-hidden />
          Settings
        </Link>
        <Menu>
          <MenuTrigger asChild>
            <button type="button" className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-sunken">
              <Avatar name={viewer.name} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-primary">{viewer.name}</span>
                <span className="block truncate text-[11.5px] text-muted">{viewer.email}</span>
              </span>
            </button>
          </MenuTrigger>
          <MenuContent align="start" side="top" className="w-56">
            <MenuLabel>Signed in as {viewer.email}</MenuLabel>
            <MenuItem asChild icon={<UserIcon />}>
              <Link href="/settings/profile">Profile and password</Link>
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<ArrowRightStartOnRectangleIcon />} onSelect={() => signOut()}>
              Sign out
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
    </nav>
  );

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[232px_minmax(0,1fr)]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-md">
        Skip to content
      </a>
      <aside className="sticky top-0 hidden h-dvh border-r border-line bg-canvas lg:block">{sidebar}</aside>
      <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-line bg-canvas/95 px-3 backdrop-blur lg:hidden">
        <button type="button" onClick={() => setDrawer(true)} className="rounded-md p-1.5 text-secondary hover:bg-sunken" aria-label="Open menu">
          <Bars3Icon className="size-5" />
        </button>
        <span className="flex-1 truncate text-[14px] font-semibold text-primary">{workspace.name}</span>
        <button type="button" onClick={openPalette} className="rounded-md p-1.5 text-secondary hover:bg-sunken" aria-label="Search">
          <MagnifyingGlassIcon className="size-5" />
        </button>
      </header>
      {drawer ? (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 animate-fade-in bg-overlay" onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 left-0 w-72 animate-slide-up border-r border-line bg-canvas pt-[env(safe-area-inset-top)] shadow-lg">
            <button type="button" onClick={() => setDrawer(false)} className="absolute top-3 right-3 rounded-md p-1.5 text-muted hover:bg-sunken" aria-label="Close menu">
              <XMarkIcon className="size-5" />
            </button>
            {sidebar}
          </div>
        </div>
      ) : null}
      <main id="main" className="min-w-0 bg-background lg:min-h-dvh">
        {children}
      </main>
      <CommandPalette />
      <CreateDialogs />
      <NextStepDialog />
    </div>
  );
}

/** The header row every page starts with: title, optional count, and actions on the right. */
export function PageHeader({ title, count, children, sub }: { title: ReactNode; count?: number; children?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-line px-4 py-3.5 lg:px-6">
      <div className="min-w-0 flex-1">
        <h1 className="flex items-baseline gap-2 text-page-title">
          {title}
          {count !== undefined ? <span className="text-[14px] font-medium text-muted tabular-nums">{count.toLocaleString()}</span> : null}
        </h1>
        {sub}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}
