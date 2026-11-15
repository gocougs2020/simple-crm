"use client";

import clsx from "clsx";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { listCampaignRecipients } from "@/actions/campaigns";
import { useApp } from "@/components/app-context";
import { StatusBadge } from "@/components/ui/badge";
import { Button, Spinner } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/menu";
import { appConfig } from "@/app.config";
import type { CampaignDelivery, RecipientFilter } from "@/lib/email/delivery";
import { deliveryLabels, deliveryTone } from "@/lib/email/delivery-status";
import { formatDateTime } from "@/lib/format";

type Recipients = Awaited<ReturnType<typeof listCampaignRecipients>>;

const { trackOpens, trackClicks } = appConfig.email;
const engagement = trackOpens || trackClicks;

const filterLabels: Partial<Record<RecipientFilter, string>> = {
  all: "Everyone",
  delivered: "Delivered",
  ...(trackOpens ? { opened: "Opened" } : {}),
  ...(trackClicks ? { clicked: "Clicked" } : {}),
  problems: "Didn't arrive",
  pending: "Waiting",
};

/**
 * How a sent campaign did, from Resend's delivery reports: the totals, then
 * every recipient with their email's status. Opens and clicks appear only
 * when this deployment tracks them (`email` in app.config.ts), and come after
 * delivery: opens are approximate.
 */
export function CampaignReport({ campaignId, delivery, sending }: { campaignId: string; delivery: CampaignDelivery | null; sending: boolean }) {
  const { workspace } = useApp();
  const [filter, setFilter] = useState<RecipientFilter>("all");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<Recipients | null>(null);
  const [loading, start] = useTransition();

  useEffect(() => {
    start(async () => setData(await listCampaignRecipients(campaignId, filter, page)));
  }, [campaignId, filter, page]);

  const d = delivery;
  const stats = d
    ? [
        { label: "Sent", value: d.sent.toLocaleString() },
        { label: "Delivered", value: d.reported ? `${d.deliveryRate}%` : "—", sub: d.reported ? `${d.delivered.toLocaleString()} emails` : "No reports yet" },
        ...(trackOpens ? [{ label: "Opened", value: d.opened ? `${d.openRate}%` : "—", sub: d.opened ? `${d.opened.toLocaleString()} people` : undefined }] : []),
        ...(trackClicks ? [{ label: "Clicked", value: d.clicked ? `${d.clickRate}%` : "—", sub: d.clicked ? `${d.clicked.toLocaleString()} people` : undefined }] : []),
        { label: "Didn't arrive", value: d.notDelivered.toLocaleString(), sub: d.complained ? `${d.complained} marked as spam` : undefined, bad: d.notDelivered + d.complained > 0 },
      ]
    : [];
  const pages = data ? Math.ceil(data.total / data.pageSize) : 0;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="report-title">
      <div className="flex items-baseline justify-between">
        <h2 id="report-title" className="text-label">
          Delivery
        </h2>
        {sending ? <span className="text-[12.5px] text-muted">Still sending. Numbers fill in as reports arrive.</span> : d && d.pending ? <span className="text-[12.5px] text-muted">{d.pending.toLocaleString()} waiting for a report</span> : null}
      </div>
      {d ? (
        <dl className={clsx("grid grid-cols-2 gap-2", stats.length > 3 ? "sm:grid-cols-5" : "sm:grid-cols-3")}>
          {stats.map((s) => (
            <div key={s.label} className="rounded-lg border border-line bg-surface px-3 py-2">
              <dt className="text-[12px] text-muted">{s.label}</dt>
              <dd className={clsx("text-[18px] font-semibold tabular-nums", s.bad ? "text-error" : "text-primary")}>{s.value}</dd>
              {s.sub ? <dd className="text-[11.5px] text-faint">{s.sub}</dd> : null}
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-[13px] text-muted">Nothing has gone out yet.</p>
      )}

      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Recipients">
        {(Object.keys(filterLabels) as RecipientFilter[]).map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={filter === f}
            onClick={() => {
              setFilter(f);
              setPage(0);
            }}
            className={clsx("h-7 rounded-md px-2.5 text-[12.5px] font-medium", filter === f ? "bg-sunken text-primary" : "text-muted hover:text-secondary")}
          >
            {filterLabels[f]}
          </button>
        ))}
        {loading ? <Spinner className="ml-1 self-center text-faint" /> : null}
      </div>

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-left text-[13px]">
          <thead className="bg-sunken/60 text-[12px] text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Recipient</th>
              <th className="px-3 py-2 font-medium">Status</th>
              {engagement ? <th className="px-3 py-2 font-medium">Engagement</th> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {data?.rows.map((r) => (
              <tr key={r.id}>
                <td className="max-w-0 px-3 py-2">
                  {r.personId ? (
                    <Link href={`/people/${r.personId}`} className="block truncate font-medium text-primary hover:underline">
                      {r.name ?? r.to}
                    </Link>
                  ) : (
                    <span className="block truncate text-primary">{r.name ?? r.to}</span>
                  )}
                  <span className="block truncate text-[12px] text-muted">{r.to}</span>
                </td>
                <td className="px-3 py-2">
                  {r.status ? (
                    <Tooltip content={r.detail ?? (r.statusAt ? formatDateTime(r.statusAt, workspace.timezone) : deliveryLabels[r.status])}>
                      <StatusBadge tone={deliveryTone[r.status]}>{deliveryLabels[r.status]}</StatusBadge>
                    </Tooltip>
                  ) : (
                    <span className="text-[12px] text-faint">Waiting</span>
                  )}
                </td>
                {engagement ? (
                  <td className="px-3 py-2 text-[12px] whitespace-nowrap text-secondary">{trackClicks && r.clickedAt ? "Clicked" : trackOpens && r.openedAt ? "Opened" : <span className="text-faint">—</span>}</td>
                ) : null}
              </tr>
            ))}
            {data && !data.rows.length ? (
              <tr>
                <td colSpan={engagement ? 3 : 2} className="px-3 py-6 text-center text-[13px] text-muted">
                  No one here yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {pages > 1 ? (
        <div className="flex items-center justify-end gap-2 text-[12.5px] text-muted">
          <span className="tabular-nums">
            {(page * (data?.pageSize ?? 0) + 1).toLocaleString()}–{Math.min((page + 1) * (data?.pageSize ?? 0), data?.total ?? 0).toLocaleString()} of {data?.total.toLocaleString()}
          </span>
          <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <Button size="sm" variant="outline" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>
            Next
          </Button>
        </div>
      ) : null}
    </section>
  );
}
