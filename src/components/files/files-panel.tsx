"use client";

import clsx from "clsx";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DocumentIcon, PhotoIcon } from "@heroicons/react/20/solid";
import { useApp } from "@/components/app-context";
import { toast } from "@/components/ui/toast";
import { uploadFile, type FileLinks } from "./upload";

/** Upload progress, shared by record timelines and the Files page. */
export function useUploader(links: FileLinks) {
  const { services } = useApp();
  const router = useRouter();
  const [uploads, setUploads] = useState<{ name: string; pct: number }[]>([]);
  const run = async (list: FileList | File[]) => {
    const files = [...list];
    if (!files.length) return;
    setUploads(files.map((f) => ({ name: f.name, pct: 0 })));
    let ok = 0;
    for (const [i, f] of files.entries()) {
      try {
        await uploadFile(f, links, services.blob, (pct) => setUploads((u) => u.map((x, j) => (j === i ? { ...x, pct } : x))));
        ok++;
      } catch (err) {
        toast.error((err as Error).message);
      }
    }
    setUploads([]);
    if (ok) {
      toast.success(ok === 1 ? `${files.find((_, i) => i === 0)?.name} uploaded` : `${ok} files uploaded`);
      router.refresh();
    }
  };
  return { uploads, run };
}

export function FileIcon({ type, className }: { type: string; className?: string }) {
  const Icon = type.startsWith("image/") ? PhotoIcon : DocumentIcon;
  return <Icon className={clsx("size-4 shrink-0 text-faint", className)} aria-hidden />;
}
