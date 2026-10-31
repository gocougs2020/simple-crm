import { NextResponse } from "next/server";

/** Public: the brand kit logo, for email clients. Only files under brand/ in the store can be read here. */
export async function GET(_: Request, { params }: RouteContext<"/brand/logo/[name]">) {
  const { name } = await params;
  if (!/^[0-9a-f-]{36}\.(png|jpg|webp|gif)$/.test(name) || !process.env.BLOB_READ_WRITE_TOKEN) return new NextResponse("Not found", { status: 404 });
  const { get } = await import("@vercel/blob");
  const blob = await get(`brand/${name}`, { access: "private" });
  if (!blob || blob.statusCode !== 200 || !blob.stream) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(blob.stream, {
    headers: {
      "Content-Type": blob.blob.contentType,
      // Each upload gets a new name, so the file at a URL never changes.
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
