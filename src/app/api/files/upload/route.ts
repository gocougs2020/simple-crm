import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { getUser } from "@/lib/auth";
import { MAX_FILE_BYTES } from "@/lib/constants";
import { forbiddenMessage, roleCan } from "@/lib/permissions";
import { fileProblem } from "@/lib/files";

/**
 * Issues short-lived tokens so the browser can upload straight to a private
 * Vercel Blob store (no 4.5 MB function body limit). Signed-in teammates who can edit records; viewers can't upload anywhere.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as HandleUploadBody;
  try {
    const json = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const user = await getUser();
        if (!user) throw new Error("Sign in to upload files.");
        if (!pathname.startsWith("files/")) throw new Error("Invalid upload path.");
        // Viewers can't add files anywhere, the team chat included.
        if (!roleCan(user.role, "records:write")) throw new Error(forbiddenMessage["records:write"]);
        const { size = 1, type = "" } = JSON.parse(clientPayload || "{}") as { size?: number; type?: string };
        const problem = fileProblem(pathname, size, type);
        if (problem) throw new Error(problem);
        return { maximumSizeInBytes: MAX_FILE_BYTES, addRandomSuffix: true, validUntil: Date.now() + 10 * 60_000 };
      },
    });
    return NextResponse.json(json);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
