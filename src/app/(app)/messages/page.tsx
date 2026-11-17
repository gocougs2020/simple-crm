import type { Metadata } from "next";
import { Suspense } from "react";
import { z } from "zod";
import { MessagesView } from "@/components/messages/messages-view";
import { PageSkeleton } from "@/components/ui/skeleton";
import { isAdmin, requireUser } from "@/lib/auth";
import { readStateFor } from "@/lib/conversations/read-rules";
import { recordContext } from "@/lib/conversations/record-context";
import { getTextThread, listTextThreads, unreadTextCount, type TextFilter } from "@/lib/conversations/texts";
import { phoneConfigured } from "@/lib/twilio/config";

export const metadata: Metadata = { title: "Messages" };

const filters = ["all", "unread", "mine", "unknown"] as const satisfies readonly TextFilter[];

export default function MessagesPage({ searchParams }: PageProps<"/messages">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Messages searchParams={searchParams} />
    </Suspense>
  );
}

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

async function Messages({ searchParams }: Pick<PageProps<"/messages">, "searchParams">) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!phoneConfigured()) return <MessagesView configured={false} isAdmin={isAdmin(user)} threads={[]} open={null} context={null} unread={0} filters={{ filter: "all" }} />;

  const filter: TextFilter = (filters as readonly string[]).includes(one(sp.filter) ?? "") ? (one(sp.filter) as TextFilter) : "all";
  const q = one(sp.q);
  const openId = one(sp.t);
  const [threads, unread, thread] = await Promise.all([
    listTextThreads(user.id, { q, filter }),
    unreadTextCount(user.id),
    openId && z.uuid().safeParse(openId).success ? getTextThread(openId) : null,
  ]);
  const open = thread ? { ...thread, readState: readStateFor({ read: thread.read, ownerId: thread.ownerId }, user.id) } : null;
  const context = thread ? await recordContext({ personId: thread.personId, organizationId: thread.organizationId }) : null;

  return <MessagesView configured isAdmin={isAdmin(user)} threads={threads} open={open} context={context} unread={unread} filters={{ filter, q }} />;
}
