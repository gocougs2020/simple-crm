import { connection, NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron";
import { reconcileDeliveryStatuses } from "@/lib/email/delivery";

export const maxDuration = 300;

/** Vercel Cron, hourly: asks Resend about emails whose delivery report never arrived (src/lib/email/delivery.ts). */
export async function GET(request: Request) {
  await connection();
  if (!cronAuthorized(request)) return new NextResponse("Unauthorized", { status: 401 });
  return NextResponse.json(await reconcileDeliveryStatuses());
}
