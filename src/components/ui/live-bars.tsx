"use client";

import clsx from "clsx";
import { useEffect, useRef, type RefObject } from "react";

const BAR_COUNT = 5;

/** Five bars that follow the mic (or pulse while the agent talks). Drawn straight to the DOM, so nothing re-renders per frame. */
export function LiveBars({ active, energetic, levelRef, tone }: { active: boolean; energetic: boolean; levelRef: RefObject<number> | null; tone: "user" | "assistant" | "dictation" }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    let raf = 0;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const draw = (now: number) => {
      const level = levelRef?.current ?? 0;
      for (let i = 0; i < BAR_COUNT; i++) {
        const el = bars.current[i];
        if (!el) continue;
        let amount = 0.08;
        if (energetic) {
          const t = reduced ? 0.4 : now / 1000;
          amount = 0.22 + 0.78 * Math.abs(Math.sin(t * 7.2 + i * 0.85)) * (0.4 + 0.6 * Math.abs(Math.sin(t * 2.3 + i * 0.4)));
        } else if (active) {
          amount = Math.max(0.1, Math.min(1, level * (0.72 + 0.28 * Math.sin(now / 120 + i * 1.15)) * (0.7 + (i % 3) * 0.15)));
        }
        el.style.height = `${4 + amount * (tone === "dictation" ? 14 : 26)}px`;
        el.style.opacity = energetic || active ? String(0.45 + amount * 0.55) : "0.28";
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [active, energetic, levelRef, tone]);
  return (
    <div className={clsx("flex items-center justify-center gap-[3px]", tone === "dictation" ? "h-5" : "h-8")} aria-hidden>
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          className={clsx("w-[3px] rounded-full", tone === "user" ? "bg-accent-foreground" : "bg-accent")}
          style={{ height: 4 }}
        />
      ))}
    </div>
  );
}
