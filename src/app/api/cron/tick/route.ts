import { connection, NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron";
import { tick } from "@/lib/cron-tick";

export const maxDuration = 300;

/**
 * Vercel Cron, on the quarter hour: the one scheduled job that wakes the
 * database. It asks what's due in one query and runs only the jobs that
 * have work (src/lib/cron-tick.ts), so a quiet quarter hour is one query
 * and no writes.
 */
export async function GET(request: Request) {
  await connection();
  if (!cronAuthorized(request)) return new NextResponse("Unauthorized", { status: 401 });
  return NextResponse.json(await tick());
}
