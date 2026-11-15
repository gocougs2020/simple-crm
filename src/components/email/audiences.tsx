"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { ChevronLeftIcon, PlusIcon } from "@heroicons/react/20/solid";
import { UserGroupIcon } from "@heroicons/react/24/outline";
import { deleteAudience, previewAudience, saveAudience } from "@/actions/audiences";
import { useApp } from "@/components/app-context";
import { PageHeader } from "@/components/shell/app-shell";
import { Button, Spinner } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import type { CampaignAudience } from "@/db/schema";
import { formatDateTime } from "@/lib/format";
import { AudienceFilters, hasFilters } from "./audience-filters";
import { EmailTabs } from "./email-tabs";

type AudienceRow = { id: string; name: string; description: string | null; filters: CampaignAudience; createdBy: string | null; updatedAt: Date; campaigns: number; count: number };

export function AudienceList({ rows }: { rows: AudienceRow[] }) {
  const { workspace, member, canEdit } = useApp();
  return (
    <>
      <PageHeader title="Email">
        {canEdit ? (
          <Button variant="primary" asChild>
            <Link href="/email/audiences/new">
              <PlusIcon />
              Audience
            </Link>
          </Button>
        ) : null}
      </PageHeader>
      <EmailTabs />
      <div className="mx-auto max-w-5xl px-4 py-5 lg:px-6">
        {rows.length ? (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {rows.map((a) => (
              <li key={a.id}>
                <Link href={`/email/audiences/${a.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-sunken/50">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium text-primary">{a.name}</span>
                    <span className="block truncate text-[12.5px] text-muted">
                      {a.description || `By ${member(a.createdBy)?.name ?? "a former teammate"} · edited ${formatDateTime(a.updatedAt, workspace.timezone)}`}
                    </span>
                  </span>
                  <span className="text-right text-[12.5px] text-muted tabular-nums">
                    <span className="block font-medium text-secondary">
                      {a.count.toLocaleString()} {a.count === 1 ? "person" : "people"}
                    </span>
                    {a.campaigns ? `Used by ${a.campaigns} ${a.campaigns === 1 ? "campaign" : "campaigns"}` : "Not used yet"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={UserGroupIcon}
            title="No saved audiences yet"
            description="Save a set of filters, like prospects in a pipeline or everyone tagged “newsletter”, and pick it for any campaign. Who's in it is worked out when the campaign sends."
            action={
              canEdit ? (
                <Button variant="primary" asChild>
                  <Link href="/email/audiences/new">Create an audience</Link>
                </Button>
              ) : undefined
            }
          />
        )}
      </div>
    </>
  );
}

type Preview = Awaited<ReturnType<typeof previewAudience>>;

/** Name and filters on the left, who matches right now on the right. */
export function AudienceEditor({ audience, tags, clientTags }: { audience: { id: string; name: string; description: string | null; filters: CampaignAudience; createdBy: string | null } | null; tags: string[]; clientTags: string[] }) {
  const router = useRouter();
  const { viewer, isAdmin, canEdit } = useApp();
  const [name, setName] = useState(audience?.name ?? "");
  const [description, setDescription] = useState(audience?.description ?? "");
  const [filters, setFilters] = useState<CampaignAudience>(audience?.filters ?? {});
  const [preview, setPreview] = useState<(Preview & { key: string }) | null>(null);
  const key = JSON.stringify(filters);
  const counting = preview?.key !== key;
  const [pending, start] = useTransition();
  const canDelete = !!audience && (audience.createdBy === viewer.id || isAdmin);

  // Recount as filters change, debounced.
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      previewAudience(JSON.parse(key)).then(
        (p) => live && setPreview({ ...p, key }),
        () => live && toast.error("Couldn't count this audience. Try again in a moment."),
      );
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key]);

  const save = () =>
    start(async () => {
      const r = await saveAudience(audience?.id ?? null, { name, description: description || null, filters });
      if (!r.ok) return void toast.error(r.error);
      toast.success(audience ? "Audience saved. Campaigns using it send to the new filters." : "Audience saved. Pick it in any campaign.");
      router.push("/email/audiences");
    });

  return (
    <div className="mx-auto max-w-5xl px-4 py-5 lg:px-6">
      <Link href="/email/audiences" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-primary">
        <ChevronLeftIcon className="size-4" />
        Audiences
      </Link>
      <h1 className="text-page-title">{audience ? audience.name : "New audience"}</h1>
      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex flex-col gap-4">
          <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Prospects in proposal stage" disabled={!canEdit} />}</Field>
          <Field label="Description" optional>
            {(p) => <Input {...p} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Who this is for" disabled={!canEdit} />}
          </Field>
          <div>
            <p className="mb-1.5 text-label">Who&apos;s in it</p>
            <div className="flex flex-col gap-3 rounded-xl border border-line p-3.5">
              <p className="text-[12.5px] text-muted">Everyone with an email who hasn&apos;t opted out or bounced{hasFilters(filters) ? ", narrowed to people who match all of these:" : "."}</p>
              <AudienceFilters audience={filters} onChange={setFilters} tags={tags} clientTags={clientTags} readOnly={!canEdit} />
            </div>
          </div>
          {canEdit ? (
            <div className="flex items-center gap-2 border-t border-line pt-4">
              {canDelete ? (
                <Button
                  variant="ghost"
                  className="text-error"
                  onClick={() =>
                    start(async () => {
                      if (!confirm(`Delete “${audience!.name}”? Campaigns using it keep its current filters.`)) return;
                      const r = await deleteAudience(audience!.id);
                      if (!r.ok) return void toast.error(r.error);
                      router.push("/email/audiences");
                    })
                  }
                >
                  Delete
                </Button>
              ) : null}
              <div className="ml-auto flex gap-2">
                <Button variant="ghost" asChild>
                  <Link href="/email/audiences">Cancel</Link>
                </Button>
                <Button variant="primary" loading={pending} onClick={save} disabled={!name.trim()}>
                  Save audience
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        <aside className="flex flex-col gap-3 self-start rounded-xl border border-line bg-surface p-4 lg:sticky lg:top-4" aria-live="polite">
          <div className="flex items-baseline justify-between">
            <span className="text-label">Matches now</span>
            {counting ? <Spinner className="text-faint" /> : null}
          </div>
          <p className="text-[24px] font-semibold text-primary tabular-nums">
            {preview ? preview.count.toLocaleString() : "—"} <span className="text-[14px] font-normal text-muted">{preview?.count === 1 ? "person" : "people"}</span>
          </p>
          {preview?.sample.length ? (
            <ul className="flex flex-col gap-2 border-t border-line pt-3">
              {preview.sample.map((p) => (
                <li key={p.id} className="min-w-0 text-[13px]">
                  <Link href={`/people/${p.id}`} className="block truncate font-medium text-primary hover:underline">
                    {p.name}
                  </Link>
                  <span className="block truncate text-[12px] text-muted">
                    {p.email}
                    {p.clientName ? ` · ${p.clientName}` : p.organizationName ? ` · ${p.organizationName}` : ""}
                  </span>
                </li>
              ))}
              {preview.count > preview.sample.length ? <li className="text-[12px] text-faint">and {(preview.count - preview.sample.length).toLocaleString()} more</li> : null}
            </ul>
          ) : preview ? (
            <p className="text-[13px] text-muted">No one matches yet. Loosen a filter to include more people.</p>
          ) : null}
          <p className="text-fine">Worked out again when a campaign sends, so people added later are included.</p>
        </aside>
      </div>
    </div>
  );
}
