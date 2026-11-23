import { connection, NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron";
import { stripeConfigured } from "@/lib/stripe";
import { syncStripe } from "@/lib/stripe/sync";

export const maxDuration = 300;

/** Vercel Cron, once a day on the hour (one of the quarter-hour blocks the other crons use): copies every connected Stripe account's customers, subscriptions, invoices and payments and rolls them up onto clients (src/lib/stripe/sync.ts). */
export async function GET(request: Request) {
  await connection();
  if (!cronAuthorized(request)) return new NextResponse("Unauthorized", { status: 401 });
  if (!stripeConfigured()) return NextResponse.json({ skipped: "Stripe isn't connected." });
  return NextResponse.json(await syncStripe());
}
