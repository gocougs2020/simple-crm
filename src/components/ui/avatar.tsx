import clsx from "clsx";
import { initials } from "@/lib/format";

/**
 * Initials avatar. The shade comes from the name, so each teammate keeps the
 * same one everywhere, but stays within the neutral palette.
 */
const shades = ["#e4e4e7", "#d4d4d8", "#e7e5e4", "#d6d3d1", "#e5e7eb", "#d1d5db"];

function shade(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
  return shades[Math.abs(h) % shades.length];
}

const sizes = { xs: "size-5 text-[9px]", sm: "size-6 text-[10px]", md: "size-8 text-[12px]", lg: "size-10 text-[14px]", xl: "size-12 text-[16px]" };

export function Avatar({ name, size = "sm", square, className }: { name: string; size?: keyof typeof sizes; square?: boolean; className?: string }) {
  return (
    <span
      className={clsx("inline-flex shrink-0 items-center justify-center font-semibold text-secondary select-none", square ? "rounded-md" : "rounded-full", sizes[size], className)}
      style={{ backgroundColor: shade(name) }}
      title={name}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}
