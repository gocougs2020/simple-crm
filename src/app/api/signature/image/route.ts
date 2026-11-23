import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth";
import { blobConfigured } from "@/lib/files";
import { siteOrigin } from "@/lib/origin";
import { roleCan } from "@/lib/permissions";

const types: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/**
 * An image for a teammate's email signature: a headshot, a logo, a badge.
 * Stored in the private Blob store like the brand kit logo and served
 * publicly from /brand/signature/[name], because the inboxes it's sent to must
 * be able to load it. Anyone who can send email; raster images only (no SVG,
 * which can carry script); 1 MB, since it goes out with every email.
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Your session ended. Sign in again to continue." }, { status: 401 });
  if (!roleCan(user.role, "records:write")) return NextResponse.json({ error: "Viewers can't send email, so they can't add signature images." }, { status: 403 });
  if (!blobConfigured()) return NextResponse.json({ error: "Connect Vercel Blob to upload images, or add one from a link." }, { status: 400 });
  const file = (await request.formData()).get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file." }, { status: 400 });
  const ext = types[file.type];
  if (!ext) return NextResponse.json({ error: "Use a PNG, JPEG, WebP or GIF image." }, { status: 400 });
  if (file.size > 1024 * 1024) return NextResponse.json({ error: "Use an image under 1 MB. Signatures go out with every email, so smaller is better." }, { status: 400 });
  const { put } = await import("@vercel/blob");
  const name = `${crypto.randomUUID()}.${ext}`;
  await put(`signatures/${name}`, file, { access: "private", contentType: file.type });
  return NextResponse.json({ url: `${await siteOrigin()}/brand/signature/${name}` });
}
