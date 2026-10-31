import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AuthFrame } from "@/components/auth/auth-frame";
import { Button } from "@/components/ui/button";
import { getDb, schema } from "@/db";
import { verifyUnsubscribe } from "@/lib/auth";
import { getWorkspace } from "@/lib/workspace";

export const metadata: Metadata = { title: "Unsubscribe" };

/** Where the link in campaign emails lands. Unsubscribing takes a click (a POST), so link scanners can't do it by accident. */
export default function UnsubscribePage({ searchParams }: PageProps<"/unsubscribe">) {
  return (
    <Suspense fallback={<main className="min-h-dvh bg-canvas" />}>
      <Unsubscribe searchParams={searchParams} />
    </Suspense>
  );
}

async function unsubscribe(formData: FormData) {
  "use server";
  const personId = await verifyUnsubscribe(String(formData.get("t") ?? ""));
  if (!personId) return;
  const db = await getDb();
  await db.update(schema.people).set({ unsubscribedAt: new Date(), marketingOptIn: false }).where(eq(schema.people.id, personId));
  redirect("/unsubscribe?done=1");
}

async function Unsubscribe({ searchParams }: Pick<PageProps<"/unsubscribe">, "searchParams">) {
  const { t, done } = await searchParams;
  const ws = await getWorkspace();
  if (done)
    return (
      <AuthFrame workspace={ws.name} title="You're unsubscribed" description={`You won't get marketing emails from ${ws.name} anymore.`}>
        <p className="text-[14px] text-secondary">Changed your mind? Reply to any of our emails and we&apos;ll add you back.</p>
      </AuthFrame>
    );
  const valid = typeof t === "string" && !!(await verifyUnsubscribe(t));
  return (
    <AuthFrame workspace={ws.name} title="Unsubscribe" description={valid ? `Stop getting marketing emails from ${ws.name}.` : "This link isn't valid. It may have been cut off in your email app."}>
      {valid ? (
        <form action={unsubscribe}>
          <input type="hidden" name="t" value={t} />
          <Button type="submit" variant="primary" size="lg" className="w-full">
            Unsubscribe
          </Button>
        </form>
      ) : null}
    </AuthFrame>
  );
}
