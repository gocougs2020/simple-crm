import "server-only";
import { cookies } from "next/headers";
import { isTimeZone, TIME_ZONE_COOKIE } from "@/lib/time-zone";

/** The signed-in teammate's time zone, from their browser (src/lib/time-zone.ts), or `workspaceTz` until it's known. */
export async function viewerTimeZone(workspaceTz: string) {
  const tz = (await cookies()).get(TIME_ZONE_COOKIE)?.value;
  return isTimeZone(tz) ? tz : workspaceTz;
}
