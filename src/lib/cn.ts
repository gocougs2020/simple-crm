import clsx, { type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Our type-scale utilities (globals.css) are font sizes, not colors, so `text-label text-primary` keeps both.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: ["page-title", "section", "label", "fine", "table-header"] }] } },
});

/** Joins class names; later Tailwind classes override earlier ones (so `className="w-40"` beats a component's `w-full`). */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
