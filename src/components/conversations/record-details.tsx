"use client";

import Link from "next/link";
import { BriefcaseIcon, BuildingOffice2Icon, CalendarDaysIcon, EnvelopeIcon, PhoneIcon, StarIcon, UserPlusIcon } from "@heroicons/react/20/solid";
import { useApp } from "@/components/app-context";
import { CategoryBadge, HealthBadge } from "@/components/clients/client-controls";
import { openCreate } from "@/components/shell/create-store";
import { Avatar } from "@/components/ui/avatar";
import { StatusBadge, Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { RecordContext } from "@/lib/conversations/record-context";
import { formatAgo, formatDateOnly, formatDateTime, formatDay } from "@/lib/format";
import { formatPhone } from "@/lib/phone/numbers";

/**
 * Who a conversation is with, beside it: the person, the organization they're
 * at and the clients (deals) they're part of, so a reply never needs a
 * second tab. `unknown` is the number or address when nobody in the CRM has it.
 */
export function RecordDetails({ context, unknown }: { context: RecordContext | null; unknown?: { phone?: string; email?: string } }) {
  if (!context) return <UnknownSender {...unknown} />;
  const { person, organization, deals, next } = context;
  return (
    <div className="flex flex-col gap-3 p-3">
      {person ? <PersonCard person={person} organizationName={organization?.name ?? null} /> : null}
      {organization ? <OrganizationCard organization={organization} /> : null}
      <DealsCard deals={deals} />
      {next ? <NextCard next={next} /> : null}
    </div>
  );
}

function Section({ title, icon: Icon, action, children }: { title: string; icon: typeof BriefcaseIcon; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface">
      <header className="flex items-center gap-1.5 px-3.5 pt-3 pb-1.5">
        <Icon className="size-4 text-faint" aria-hidden />
        <h3 className="flex-1 text-[12.5px] font-semibold text-primary">{title}</h3>
        {action}
      </header>
      <div className="px-3.5 pb-3">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 py-0.5 text-[12.5px]">
      <dt className="w-16 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 truncate text-secondary">{children}</dd>
    </div>
  );
}

function PersonCard({ person, organizationName }: { person: NonNullable<RecordContext["person"]>; organizationName: string | null }) {
  const { member, workspace } = useApp();
  const owner = member(person.ownerId);
  return (
    <section className="rounded-xl border border-line bg-surface p-3.5">
      <div className="flex items-start gap-2.5">
        <Avatar name={person.name} size="lg" />
        <div className="min-w-0 flex-1">
          <Link href={`/people/${person.id}`} className="flex items-center gap-1 text-[14px] font-semibold text-primary hover:underline">
            <span className="truncate">{person.name}</span>
            {person.decisionMaker ? <StarIcon className="size-3.5 shrink-0 text-warning" aria-label="Decision maker" /> : null}
          </Link>
          {person.title || organizationName ? <p className="truncate text-[12.5px] text-muted">{[person.title, organizationName].filter(Boolean).join(" at ")}</p> : null}
        </div>
      </div>
      {person.archived || person.textOptedOut || person.unsubscribed ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {person.archived ? <StatusBadge tone="neutral">Archived</StatusBadge> : null}
          {person.textOptedOut ? <StatusBadge tone="error">Replied STOP</StatusBadge> : null}
          {person.unsubscribed ? <StatusBadge tone="warning">Unsubscribed</StatusBadge> : null}
        </div>
      ) : null}
      <dl className="mt-2.5">
        {person.email ? (
          <Row label="Email">
            <a href={`mailto:${person.email}`} className="hover:text-primary hover:underline">
              {person.email}
            </a>
          </Row>
        ) : null}
        {person.phone ? <Row label="Phone">{formatPhone(person.phone)}</Row> : null}
        <Row label="Owner">{owner ? owner.name : <span className="text-muted" title="With nobody owning them, their new messages are unread for everyone until someone opens them.">Nobody, so unread for all</span>}</Row>
        <Row label="Last touch">
          {person.lastActivityAt ? (
            <time dateTime={person.lastActivityAt} suppressHydrationWarning>
              {formatAgo(person.lastActivityAt, workspace.timezone)}
            </time>
          ) : (
            "Never"
          )}
        </Row>
      </dl>
      {person.tags.length ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {person.tags.map((t) => (
            <Tag key={t}>{t}</Tag>
          ))}
        </div>
      ) : null}
      {person.summary ? <p className="mt-2.5 line-clamp-6 border-t border-line pt-2.5 text-[12.5px] leading-relaxed text-secondary">{person.summary}</p> : null}
    </section>
  );
}

function OrganizationCard({ organization }: { organization: RecordContext["organization"] & {} }) {
  const { member } = useApp();
  const owner = member(organization.ownerId);
  return (
    <Section title="Company" icon={BuildingOffice2Icon}>
      <Link href={`/organizations/${organization.id}`} className="block truncate text-[13.5px] font-medium text-primary hover:underline">
        {organization.name}
      </Link>
      <dl className="mt-1">
        {organization.industry ? <Row label="Industry">{organization.industry}</Row> : null}
        {organization.domain ? (
          <Row label="Website">
            <a href={`https://${organization.domain}`} target="_blank" rel="noreferrer" className="hover:text-primary hover:underline">
              {organization.domain}
            </a>
          </Row>
        ) : null}
        {organization.phone ? <Row label="Phone">{formatPhone(organization.phone)}</Row> : null}
        {owner ? <Row label="Owner">{owner.name}</Row> : null}
      </dl>
    </Section>
  );
}

function DealsCard({ deals }: { deals: RecordContext["deals"] }) {
  const { stage, money, member, workspace } = useApp();
  return (
    <Section title="Clients" icon={BriefcaseIcon}>
      {deals.length ? (
        <ul className="-mx-1 flex flex-col">
          {deals.map((d) => {
            const s = stage(d.stageId);
            const owner = member(d.ownerId);
            return (
              <li key={d.id}>
                <Link href={`/clients/${d.id}`} className="block rounded-md px-1 py-1.5 hover:bg-sunken">
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-primary">{d.name}</span>
                    <CategoryBadge category={d.category} />
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-muted">
                    {s ? <span>{s.name}</span> : null}
                    {d.category === "prospective" && d.value ? <span>· {money(d.value, { compact: true })}</span> : null}
                    {d.category === "prospective" && d.expectedCloseDate ? <span>· closes {formatDateOnly(d.expectedCloseDate, workspace.timezone)}</span> : null}
                    {owner ? <span>· {owner.name}</span> : null}
                    {d.category === "current" ? <HealthBadge health={d.health} /> : null}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-[12.5px] text-muted">Not part of any client yet.</p>
      )}
    </Section>
  );
}

function NextCard({ next }: { next: NonNullable<RecordContext["next"]> }) {
  const { member, workspace } = useApp();
  const who = member(next.assigneeId);
  return (
    <Section title="Next up" icon={CalendarDaysIcon}>
      <p className="truncate text-[13px] font-medium text-primary">{next.subject || (next.type === "meeting" ? "Meeting" : next.type === "call" ? "Call" : "Task")}</p>
      <p className="text-[12px] text-muted" suppressHydrationWarning>
        {next.dueHasTime ? formatDateTime(next.dueAt, workspace.timezone) : formatDay(next.dueAt, workspace.timezone)}
        {who ? ` · ${who.name}` : ""}
      </p>
    </Section>
  );
}

function UnknownSender({ phone, email }: { phone?: string; email?: string }) {
  const { canEdit } = useApp();
  return (
    <div className="p-3">
      <section className="rounded-xl border border-dashed border-line-strong bg-surface p-3.5">
        <p className="flex items-center gap-1.5 text-[13px] font-semibold text-primary">
          {phone ? <PhoneIcon className="size-4 text-faint" aria-hidden /> : <EnvelopeIcon className="size-4 text-faint" aria-hidden />}
          {phone ? formatPhone(phone) : email}
        </p>
        <p className="mt-1 text-[12.5px] text-muted">
          Nobody in the CRM has this {phone ? "number" : "address"}, so everyone sees it as unread until someone opens it.
          {canEdit ? (phone ? " Add them as a person and the conversation moves onto their record." : " Add them as a person, then link the conversation to them.") : ""}
        </p>
        {canEdit ? (
          <Button size="sm" variant="outline" className="mt-2.5" onClick={() => openCreate({ kind: "person", defaults: { phone, email, openAfter: false } })}>
            <UserPlusIcon />
            Add person
          </Button>
        ) : null}
      </section>
    </div>
  );
}
