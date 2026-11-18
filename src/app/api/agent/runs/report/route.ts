import { NextResponse } from "next/server";
import { readJson } from "@/lib/agent/http";
import { applyReport, runReport } from "@/lib/agent/runs";
import { RUN_TOKEN_PREFIX, verifyRunToken } from "@/lib/agent/run-token";
import { keyFromHeaders } from "@/lib/api/key-format";
import { NotFoundError } from "@/lib/errors";

export const maxDuration = 60;

/**
 * Where the eve agent reports how a background run went (agent/hooks/report.ts):
 * its answer, a failure, and what it has cost. The token is signed for one
 * run with the secret both services share, so nothing else can report.
 */
export async function POST(request: Request) {
  const bearer = keyFromHeaders(request.headers);
  const claims = bearer?.startsWith(RUN_TOKEN_PREFIX) ? await verifyRunToken("report", bearer.slice(RUN_TOKEN_PREFIX.length)) : null;
  if (!claims) return NextResponse.json({ error: 401, message: "That report isn't signed for a background task." }, { status: 401 });
  let report;
  try {
    report = runReport.parse(await readJson(request, 600_000));
  } catch {
    return NextResponse.json({ error: 400, message: "That report couldn't be read." }, { status: 400 });
  }
  try {
    await applyReport(claims, report);
  } catch (err) {
    if (err instanceof NotFoundError) return NextResponse.json({ error: 404, message: err.message }, { status: 404 });
    throw err;
  }
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
