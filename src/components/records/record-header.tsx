"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { ArchiveBoxIcon, ChevronRightIcon, EllipsisHorizontalIcon, LinkIcon } from "@heroicons/react/20/solid";
import { setArchived } from "@/actions/records";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { toast } from "@/components/ui/toast";
import { archivedToast } from "@/lib/format";
import { entityLabels, type EntityType } from "@/lib/constants";

/** Breadcrumb, title and the record's actions menu. */
export function RecordHeader({ entity, id, title, sub, avatar, actions, archived }: { entity: EntityType; id: string; title: string; sub?: ReactNode; avatar?: ReactNode; actions?: ReactNode; archived?: boolean }) {
  const router = useRouter();
  const label = entityLabels[entity];
  return (
    <div className="border-b border-line px-4 pt-3 pb-4 lg:px-6">
      {/* Phones have a back button in the top bar instead. */}
      <nav aria-label="Breadcrumb" className="mb-2 flex items-center gap-1 text-[12.5px] text-muted max-lg:hidden">
        <Link href={label.path} className="hover:text-primary">
          {label.many}
        </Link>
        <ChevronRightIcon className="size-3.5 text-faint" aria-hidden />
        <span className="truncate text-secondary">{title}</span>
      </nav>
      {archived ? (
        <div className="mb-3 flex items-center gap-3 rounded-lg border border-warning-border bg-warning-surface px-3 py-2 text-[13px] text-warning">
          <ArchiveBoxIcon className="size-4" />
          <span className="flex-1">This {label.one.toLowerCase()} is archived. It&apos;s hidden from lists and search.</span>
          <Button size="sm" variant="outline" onClick={() => setArchived(entity, [id], false)}>
            Restore
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {avatar}
        <div className="min-w-0 flex-1">
          <h1 className="line-clamp-2 text-page-title break-words sm:truncate">{title}</h1>
          {sub ? <div className="mt-0.5 text-[13px] text-muted">{sub}</div> : null}
        </div>
        {/* On a phone the title keeps its row (with the menu) and the actions go underneath. */}
        <div className="contents sm:flex sm:flex-wrap sm:items-center sm:gap-2">
          {actions ? <div className="order-last flex w-full flex-wrap items-center gap-2 empty:hidden sm:order-none sm:w-auto">{actions}</div> : null}
          <Menu>
            <MenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="More actions">
                <EllipsisHorizontalIcon />
              </Button>
            </MenuTrigger>
            <MenuContent className="w-48">
              <MenuItem
                icon={<LinkIcon />}
                onSelect={async () => {
                  await navigator.clipboard.writeText(window.location.href);
                  toast.success("Link copied");
                }}
              >
                Copy link
              </MenuItem>
              {!archived ? (
                <>
                  <MenuSeparator />
                  <MenuItem
                    icon={<ArchiveBoxIcon />}
                    onSelect={async () => {
                      const r = await setArchived(entity, [id], true);
                      if (!r.ok) return void toast.error(r.error);
                      toast.success(archivedToast(label.one, r.data.openActivities), { label: "Undo", onClick: () => setArchived(entity, [id], false) });
                      router.push(label.path);
                    }}
                  >
                    Archive
                  </MenuItem>
                </>
              ) : null}
            </MenuContent>
          </Menu>
        </div>
      </div>
    </div>
  );
}

/** The two-column body of a record page: details on the left, activity on the right. Stacks on narrow screens. */
export function RecordBody({ side, children }: { side: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto grid max-w-[1400px] grid-cols-[minmax(0,1fr)] gap-4 px-4 py-4 lg:grid-cols-[380px_minmax(0,1fr)] lg:gap-5 lg:px-6 lg:py-5">
      <aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-4 lg:max-h-[calc(100dvh-2rem)] lg:self-start lg:overflow-y-auto lg:pb-4 scroll-thin">{side}</aside>
      <div className="flex min-w-0 flex-col gap-6">{children}</div>
    </div>
  );
}
