import type { Metadata } from "next";
import { Suspense } from "react";
import { ArrowDownTrayIcon, ArrowTopRightOnSquareIcon } from "@heroicons/react/20/solid";
import { AuthFrame } from "@/components/auth/auth-frame";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/format";
import { inlineTypes } from "@/lib/files";
import { sharedFile } from "@/lib/share";
import { getWorkspace } from "@/lib/workspace";

export const metadata: Metadata = { title: "Shared file", robots: { index: false, follow: false }, referrer: "no-referrer" };

/** Where a public file's link lands: its name, a preview for pictures, and a download. No sign-in. */
export default function SharePage({ params }: PageProps<"/share/[token]">) {
  return (
    <Suspense fallback={<main className="min-h-dvh bg-canvas" />}>
      <Share params={params} />
    </Suspense>
  );
}

async function Share({ params }: Pick<PageProps<"/share/[token]">, "params">) {
  const { token } = await params;
  const [f, ws] = await Promise.all([sharedFile(token), getWorkspace()]);
  if (!f)
    return (
      <AuthFrame workspace={ws.name} title="This link doesn't work anymore" description="The file was made private or removed. Ask whoever sent it for a new link.">
        <p className="text-[13.5px] text-muted">Nothing else is needed from you.</p>
      </AuthFrame>
    );
  const src = `/share/${encodeURIComponent(token)}/file`;
  const picture = f.contentType.startsWith("image/") && inlineTypes.test(f.contentType);
  return (
    <AuthFrame workspace={ws.name} title={f.name} description={`${formatBytes(f.size)} · shared by ${ws.name}`}>
      {picture ? (
        // eslint-disable-next-line @next/next/no-img-element -- a private, per-link file; the image optimizer can't fetch it
        <img src={src} alt={f.name} className="mb-5 max-h-80 w-full rounded-lg border border-line bg-sunken object-contain" />
      ) : null}
      <div className="flex flex-col gap-2">
        <Button asChild variant="primary" size="lg" className="w-full">
          <a href={`${src}?download`}>
            <ArrowDownTrayIcon />
            Download
          </a>
        </Button>
        {inlineTypes.test(f.contentType) ? (
          <Button asChild size="lg" className="w-full">
            <a href={src} target="_blank" rel="noopener noreferrer">
              <ArrowTopRightOnSquareIcon />
              Open in the browser
            </a>
          </Button>
        ) : null}
      </div>
    </AuthFrame>
  );
}
