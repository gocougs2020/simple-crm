import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, schema } from "@/db";
import { verifyUnsubscribe } from "@/lib/auth";
import { currentRecordId } from "@/lib/crm/merged";

/** RFC 8058 one-click unsubscribe: mail apps POST here from their own "Unsubscribe" button. */
export async function POST(request: Request) {
  const token = new URL(request.url).searchParams.get("t") ?? "";
  const personId = await verifyUnsubscribe(token);
  if (!personId) return new NextResponse("Invalid link", { status: 400 });
  const db = await getDb();
  // A link sent to a duplicate that's since been merged unsubscribes the person it was merged into.
  await db.update(schema.people).set({ unsubscribedAt: new Date(), marketingOptIn: false }).where(eq(schema.people.id, await currentRecordId("person", personId)));
  return new NextResponse("Unsubscribed");
}
