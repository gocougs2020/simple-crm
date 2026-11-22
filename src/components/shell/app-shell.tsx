"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import clsx from "clsx";
import { Suspense, use, useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  ArrowRightStartOnRectangleIcon,
  ChevronLeftIcon,
  EllipsisHorizontalCircleIcon,
  BuildingOffice2Icon,
  CheckCircleIcon,
  Cog6ToothIcon,
  BriefcaseIcon,
  EnvelopeIcon,
  FolderIcon,
  HomeIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  UserIcon,
  CalendarDaysIcon,
  ChatBubbleLeftRightIcon,
  ChatBubbleOvalLeftEllipsisIcon,
  SparklesIcon,
} from "@heroicons/react/24/outline";
import {
  BriefcaseIcon as BriefcaseSolid,
  CheckCircleIcon as CheckCircleSolid,
  EllipsisHorizontalCircleIcon as EllipsisSolid,
  ChatBubbleOvalLeftEllipsisIcon as ChatSolid,
  HomeIcon as HomeSolid,
} from "@heroicons/react/24/solid";
import { signOut } from "@/actions/auth";
import { useApp } from "@/components/app-context";
import { Avatar } from "@/components/ui/avatar";
import { Dialog } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { AgentLauncher } from "@/components/agent/agent-launcher";
import { openAssistant } from "@/components/agent/agent-store";
import { appConfig } from "@/app.config";
import { NextStepDialog } from "@/components/activity/next-step-dialog";
import { NotificationsPrompt } from "@/components/pwa/notifications-prompt";
import { preloadRichTextWhenIdle } from "@/components/ui/rich-text";
import { CommandPalette, openPalette } from "./command-palette";
import { CreateDialogs } from "./create-dialogs";
import { openCreate } from "./create-store";
import type { SidebarCounts } from "@/lib/sidebar-counts";
import { canGoBackInApp, nextTrail } from "@/lib/back-trail";
import { setBadges, useBadgeOverride } from "./badge-store";

type Badge = { n: number; label: string; tone?: "error" };
type NavItem = { href: string; label: string; icon: ComponentType<{ className?: string }>; badge?: (c: SidebarCounts) => Badge };

/**
 * `counts` is a promise: the sidebar and page frame paint without waiting for
 * the badges, which fill in when the counts arrive.
 */
export function AppShell({ counts, children }: { counts: Promise<SidebarCounts>; children: ReactNode }) {
  const { viewer, workspace, canEdit, services, comms } = useApp();
  const pathname = usePathname();
  const [more, setMore] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- close the phone's More sheet after navigating
  useEffect(() => setMore(false), [pathname]);
  // A render brings new counts: they replace any fetched on their own since.
  useEffect(() => setBadges(null), [counts]);
  // The text editor loads on demand; fetch it once the page is idle, so it's there before anyone opens a composer.
  useEffect(() => preloadRichTextWhenIdle(), []);

  const nav: NavItem[] = [
    { href: "/", label: "Home", icon: HomeIcon },
    { href: "/clients", label: "Clients", icon: BriefcaseIcon },
    { href: "/activities", label: "Activities", icon: CheckCircleIcon, badge: activitiesBadge },
    ...(comms.phone ? [{ href: "/messages", label: "Messages", icon: ChatBubbleLeftRightIcon, badge: (c: SidebarCounts) => ({ n: c.unreadTexts, label: "unread" }) }] : []),
    { href: "/email", label: "Email", icon: EnvelopeIcon, badge: (c) => ({ n: c.unread, label: "unread" }) },
    { href: "/people", label: "People", icon: UserIcon },
    { href: "/organizations", label: "Organizations", icon: BuildingOffice2Icon },
    { href: "/calendar", label: "Calendar", icon: CalendarDaysIcon },
    { href: "/files", label: "Files", icon: FolderIcon },
    {
      href: "/chat",
      label: "Team chat",
      icon: ChatBubbleOvalLeftEllipsisIcon,
      badge: ({ chat }) => ({ n: chat.mentions || chat.unread, label: chat.mentions ? (chat.mentions === 1 ? "mention" : "mentions") : "unread", tone: chat.mentions ? "error" : undefined }),
    },
  ];
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
  // On a phone the tab bar holds these; everything else is under More.
  const tabs = new Set(phoneTabs.map((t) => t.href));
  const rest = nav.filter((n) => !tabs.has(n.href));
  const moreActive = pathname.startsWith("/settings") || rest.some((n) => isActive(n.href));

  const newMenu = (trigger: ReactNode, align: "start" | "end" = "start") =>
    canEdit ? (
      <Menu>
        <MenuTrigger asChild>{trigger}</MenuTrigger>
        <MenuContent align={align} className="w-52">
          <MenuItem icon={<BriefcaseIcon />} onSelect={() => openCreate({ kind: "client" })}>
            Client
          </MenuItem>
          <MenuItem icon={<UserIcon />} onSelect={() => openCreate({ kind: "person" })}>
            Person
          </MenuItem>
          <MenuItem icon={<BuildingOffice2Icon />} onSelect={() => openCreate({ kind: "organization" })}>
            Organization
          </MenuItem>
        </MenuContent>
      </Menu>
    ) : null;

  const navLink = (n: NavItem, touch = false) => {
    const active = isActive(n.href);
    return (
      <Link
        key={n.href}
        href={n.href}
        aria-current={active ? "page" : undefined}
        className={clsx(
          "flex items-center gap-2.5 rounded-md font-medium transition-colors",
          touch ? "h-11 px-3 text-[15px] active:bg-sunken" : "h-8 px-2.5 text-[13.5px]",
          active ? "bg-accent-soft text-accent-soft-foreground" : "text-secondary hover:bg-sunken hover:text-primary",
        )}
      >
        <n.icon className={clsx(touch ? "size-5" : "size-[18px]", active ? "text-primary" : "text-muted")} aria-hidden />
        <span className="flex-1">{n.label}</span>
        {n.badge ? (
          // No badge until the counts arrive.
          <Suspense fallback={null}>
            <NavBadge counts={counts} pick={n.badge} />
          </Suspense>
        ) : null}
      </Link>
    );
  };

  const sidebar = (
    <nav className="flex h-full flex-col gap-1 px-3 py-4" aria-label="Main">
      <div className="mb-3 flex items-center gap-2 px-2">
        <WorkspaceMark name={workspace.name} />
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
      {newMenu(
        <button type="button" className="mb-3 flex h-8 items-center gap-2 rounded-md bg-accent px-2.5 text-[13px] font-medium text-accent-foreground shadow-sm hover:bg-accent-hover">
          <PlusIcon className="size-4" aria-hidden />
          New
        </button>,
      )}
      {nav.map((n) => navLink(n))}
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
      <PhoneHeader workspace={workspace.name} newMenu={newMenu} />
      <main id="main" className="min-w-0 overflow-x-clip bg-background pb-[var(--shell-bottom)] lg:min-h-dvh">
        {children}
      </main>
      {/* Phones and small tablets: the main places sit under the thumb; the rest are one tap away under More. */}
      <nav aria-label="Main" className="app-tabbar fixed inset-x-0 bottom-0 z-30 border-t border-line bg-canvas/95 pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] backdrop-blur-md select-none lg:hidden">
        <ul className="mx-auto grid h-14 max-w-xl grid-cols-5">
          {phoneTabs.map((t) => {
            const item = nav.find((n) => n.href === t.href);
            const active = isActive(t.href);
            return (
              <li key={t.href}>
                <Link href={t.href} aria-current={active ? "page" : undefined} className={clsx("tab-item", active && "text-primary")}>
                  <span className="relative">
                    {active ? <t.solid className="size-6" aria-hidden /> : <t.icon className="size-6" aria-hidden />}
                    {item?.badge ? (
                      <Suspense fallback={null}>
                        <TabBadge counts={counts} pick={item.badge} />
                      </Suspense>
                    ) : null}
                  </span>
                  {t.label}
                </Link>
              </li>
            );
          })}
          <li>
            <button type="button" onClick={() => setMore(true)} aria-haspopup="dialog" aria-expanded={more} className={clsx("tab-item w-full", moreActive && "text-primary")}>
              <span className="relative">
                {moreActive ? <EllipsisSolid className="size-6" aria-hidden /> : <EllipsisHorizontalCircleIcon className="size-6" aria-hidden />}
                <Suspense fallback={null}>
                  <MoreDot counts={counts} picks={rest.flatMap((n) => (n.badge ? [n.badge] : []))} />
                </Suspense>
              </span>
              More
            </button>
          </li>
        </ul>
      </nav>
      <Dialog open={more} onOpenChange={setMore} title={workspace.name} size="sm">
        <nav aria-label="More" className="-mx-2 flex flex-col gap-0.5">
          {rest.map((n) => navLink(n, true))}
          <div className="my-2 h-px bg-line" />
          {navLink({ href: "/settings", label: "Settings", icon: Cog6ToothIcon }, true)}
          <Link href="/settings/profile" className="flex items-center gap-3 rounded-md px-3 py-2 active:bg-sunken">
            <Avatar name={viewer.name} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium text-primary">{viewer.name}</span>
              <span className="block truncate text-[12px] text-muted">{viewer.email}</span>
            </span>
          </Link>
          <button type="button" onClick={() => signOut()} className="flex h-11 items-center gap-2.5 rounded-md px-3 text-[15px] font-medium text-secondary active:bg-sunken">
            <ArrowRightStartOnRectangleIcon className="size-5 text-muted" aria-hidden />
            Sign out
          </button>
        </nav>
      </Dialog>
      <CommandPalette />
      <CreateDialogs />
      <NextStepDialog />
      <AgentLauncher configured={services.ai.chat} />
      <NotificationsPrompt />
    </div>
  );
}

const activitiesBadge = ({ due }: SidebarCounts): Badge => ({ n: due.overdue + due.today, label: "due", tone: due.overdue ? "error" : undefined });

/** The phone tab bar: the four places people go most. Outline icons at rest, solid when current. People are under More. */
const phoneTabs: { href: string; label: string; icon: ComponentType<{ className?: string }>; solid: ComponentType<{ className?: string }> }[] = [
  { href: "/", label: "Home", icon: HomeIcon, solid: HomeSolid },
  { href: "/clients", label: "Clients", icon: BriefcaseIcon, solid: BriefcaseSolid },
  { href: "/activities", label: "Activities", icon: CheckCircleIcon, solid: CheckCircleSolid },
  { href: "/chat", label: "Chat", icon: ChatBubbleOvalLeftEllipsisIcon, solid: ChatSolid },
];

/** Record pages, and where their back button goes when there's no in-app history to return to. */
const backTargets: { pattern: RegExp; href: string; label: string }[] = [
  { pattern: /^\/clients\/[^/]+/, href: "/clients", label: "Clients" },
  { pattern: /^\/people\/[^/]+/, href: "/people", label: "People" },
  { pattern: /^\/organizations\/[^/]+/, href: "/organizations", label: "Organizations" },
  { pattern: /^\/email\/campaigns\/[^/]+/, href: "/email/campaigns", label: "Campaigns" },
  { pattern: /^\/email\/audiences\/[^/]+/, href: "/email/audiences", label: "Audiences" },
  { pattern: /^\/email\/templates\/[^/]+/, href: "/email/templates", label: "Templates" },
];

function WorkspaceMark({ name }: { name: string }) {
  return <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-[13px] font-semibold text-accent-foreground">{name.slice(0, 1).toUpperCase()}</span>;
}

/**
 * The phone's top bar: the workspace, or a back button on a record page, then
 * New and Search. Back returns to the previous page as it was (filters, scroll)
 * when that page is in the CRM, and opens the list otherwise, so it never
 * leaves the app.
 */
function PhoneHeader({ workspace, newMenu }: { workspace: string; newMenu: (trigger: ReactNode, align?: "start" | "end") => ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const trail = useRef<string[]>([]);
  useEffect(() => {
    trail.current = nextTrail(trail.current, pathname);
  }, [pathname]);
  const back = backTargets.find((b) => b.pattern.test(pathname));
  const iconButton = "flex size-10 items-center justify-center rounded-full text-secondary transition-colors hover:bg-sunken active:bg-sunken";
  return (
    <header className="sticky top-0 z-30 flex h-[calc(3rem+env(safe-area-inset-top))] items-center gap-1 border-b border-line bg-canvas/95 pt-[env(safe-area-inset-top)] pr-[max(0.375rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] backdrop-blur-md select-none lg:hidden">
      {back ? (
        <Link
          href={back.href}
          onClick={(e) => {
            const navigation = (window as Window & { navigation?: { canGoBack?: unknown } }).navigation;
            if (e.metaKey || e.ctrlKey || !canGoBackInApp(trail.current, navigation)) return;
            e.preventDefault();
            router.back();
          }}
          className="-ml-2 flex h-10 min-w-0 items-center gap-0.5 rounded-full pr-3 pl-1 text-[15px] font-medium text-primary active:bg-sunken"
        >
          <ChevronLeftIcon className="size-5 shrink-0" aria-hidden />
          <span className="truncate">{back.label}</span>
        </Link>
      ) : (
        <Link href="/" className="flex min-w-0 items-center gap-2">
          <WorkspaceMark name={workspace} />
          <span className="truncate text-[15px] font-semibold text-primary">{workspace}</span>
        </Link>
      )}
      <span className="flex-1" />
      {newMenu(
        <button type="button" className={iconButton} aria-label="New">
          <PlusIcon className="size-[22px]" />
        </button>,
        "end",
      )}
      <button type="button" onClick={openPalette} className={iconButton} aria-label="Search">
        <MagnifyingGlassIcon className="size-[22px]" />
      </button>
      {/* On a desktop the agent has a floating button; on a phone it would cover send and save buttons, so it lives up here. */}
      {appConfig.agent.enabled ? (
        <button type="button" onClick={() => openAssistant()} className="ml-0.5 flex size-9 items-center justify-center rounded-full bg-accent text-accent-foreground transition-transform active:scale-95" aria-label={`Open ${appConfig.agent.name}`}>
          <SparklesIcon className="size-5" />
        </button>
      ) : null}
    </header>
  );
}

function TabBadge({ counts, pick }: { counts: Promise<SidebarCounts>; pick: (c: SidebarCounts) => Badge }) {
  const fetched = useBadgeOverride();
  const b = pick(fetched ?? use(counts));
  if (!b.n) return null;
  return (
    <span
      className={clsx(
        "absolute -top-1 left-[calc(100%-8px)] min-w-[18px] rounded-full px-1 text-center text-[10.5px] leading-[18px] font-semibold tabular-nums ring-2 ring-canvas",
        b.tone === "error" ? "bg-error text-white" : "bg-accent text-accent-foreground",
      )}
      aria-label={`${b.n} ${b.label}`}
    >
      {b.n > 99 ? "99+" : b.n}
    </span>
  );
}

/** A dot on More when something under it has news (unread email, a mention). */
function MoreDot({ counts, picks }: { counts: Promise<SidebarCounts>; picks: ((c: SidebarCounts) => Badge)[] }) {
  const fetched = useBadgeOverride();
  const c = fetched ?? use(counts);
  const badges = picks.map((p) => p(c)).filter((b) => b.n);
  if (!badges.length) return null;
  return (
    <>
      <span className={clsx("absolute -top-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-canvas", badges.some((b) => b.tone === "error") ? "bg-error" : "bg-accent")} aria-hidden />
      <span className="sr-only">, something new</span>
    </>
  );
}

function NavBadge({ counts, pick }: { counts: Promise<SidebarCounts>; pick: (c: SidebarCounts) => Badge }) {
  // Counts fetched on their own (badge-store.ts) are newer than the render's until the next render.
  const fetched = useBadgeOverride();
  const b = pick(fetched ?? use(counts));
  if (!b.n) return null;
  return (
    <span
      className={clsx("min-w-5 rounded-full px-1.5 text-center text-[11px] leading-5 font-semibold tabular-nums", b.tone === "error" ? "bg-error-surface text-error" : "bg-sunken text-secondary")}
      aria-label={`${b.n} ${b.label}`}
    >
      {b.n}
    </span>
  );
}

/** The header row every page starts with: title, optional count, and actions on the right. */
export function PageHeader({ title, count, children, sub }: { title: ReactNode; count?: number; children?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-line px-4 py-3.5 lg:px-6">
      {/* The title keeps at least 10rem: wider controls wrap below it on a phone instead of covering it. */}
      <div className="min-w-0 flex-1 basis-40">
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
