import { NextResponse } from "next/server";
import { getUser, isAdmin } from "@/lib/auth";
import { blobConfigured } from "@/lib/files";
import { siteOrigin } from "@/lib/origin";

const types: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/**
 * The brand kit logo. It's stored in the same private Blob store as CRM files
 * and served publicly from /brand/logo/[name], because email clients must be
 * able to load it. Admins only; raster images only (no SVG, which can carry
 * script); 2 MB.
 */
export async function POST(request: Request) {
  const user = await getUser();
  if (!user || !isAdmin(user)) return NextResponse.json({ error: "Only admins can change the logo." }, { status: 403 });
  if (!blobConfigured()) return NextResponse.json({ error: "Connect Vercel Blob to upload a logo, or paste an image URL." }, { status: 400 });
  const file = (await request.formData()).get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file." }, { status: 400 });
  const ext = types[file.type];
  if (!ext) return NextResponse.json({ error: "Use a PNG, JPEG, WebP or GIF image." }, { status: 400 });
  if (file.size > 2 * 1024 * 1024) return NextResponse.json({ error: "Use an image under 2 MB." }, { status: 400 });
  const { put } = await import("@vercel/blob");
  const name = `${crypto.randomUUID()}.${ext}`;
  await put(`brand/${name}`, file, { access: "private", contentType: file.type });
  return NextResponse.json({ url: `${await siteOrigin()}/brand/logo/${name}` });
}
