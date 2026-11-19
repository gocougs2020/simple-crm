import { NextResponse } from "next/server";
import { fileResponse } from "@/lib/file-response";
import { sharedFile } from "@/lib/share";

/** A public file's bytes, for anyone with its link. Stops working the moment it's made internal or removed. */
export async function GET(request: Request, { params }: RouteContext<"/share/[token]/file">) {
  const { token } = await params;
  const f = await sharedFile(token);
  if (!f) return new NextResponse("This link doesn't work anymore. Ask whoever sent it for a new one.", { status: 404 });
  // Not cached for long, so making it internal takes effect quickly.
  return fileResponse(f, { download: new URL(request.url).searchParams.has("download"), cache: "private, max-age=60" });
}
