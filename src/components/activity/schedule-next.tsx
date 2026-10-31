"use client";

import clsx from "clsx";
import { useState, useTransition } from "react";
import { ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { logActivity } from "@/actions/activities";
import { useApp } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import type { ActivityType } from "@/lib/constants";
import { dayFromToday, zonedTime } from "@/lib/format";
import { Segmented } from "./composer";

/**
 * Every open deal should have a next step. When it doesn't (on the deal page,
 * or right after its last task is checked off) this asks for one, in place.
 */
export function ScheduleNext({ dealId, compact, onDone }: { dealId: string; compact?: boolean; onDone?: () => void }) {
  const { workspace } = useApp();
  const tz = workspace.timezone;
  const [type, setType] = useState<Extract<ActivityType, "task" | "call" | "meeting">>("task");
  const [subject, setSubject] = useState("");
  const [days, setDays] = useState(1);
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      const r = await logActivity({ type, subject: subject || (type === "call" ? "Call" : type === "meeting" ? "Meeting" : "Follow up"), dealId, dueAt: zonedTime(dayFromToday(tz, days), "00:00", tz).toISOString(), dueHasTime: false, done: false });
      if (!r.ok) return void toast.error(r.error);
      toast.success("Next step scheduled");
      setSubject("");
      onDone?.();
    });
  return (
    <div className={clsx(!compact && "rounded-xl border border-warning-border bg-warning-surface/50 px-3.5 py-3")}>
      {!compact ? (
        <p className="flex items-center gap-1.5 text-[13px] font-medium text-warning">
          <ExclamationTriangleIcon className="size-4" aria-hidden />
          No next step planned for this deal
        </p>
      ) : (
        <p className="text-[13px] text-secondary">Every open deal should have a next step. Schedule one now?</p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Segmented
          value={type}
          onChange={setType}
          options={[
            { value: "task", label: "Task" },
            { value: "call", label: "Call" },
            { value: "meeting", label: "Meeting" },
          ]}
        />
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} placeholder="What's next?" aria-label="Next step" className="h-8 min-w-40 flex-1 text-[13px]" />
        <div className="flex gap-1" role="radiogroup" aria-label="When">
          {[
            [1, "Tomorrow"],
            [3, "3 days"],
            [7, "1 week"],
          ].map(([d, label]) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={days === d}
              onClick={() => setDays(d as number)}
              className={clsx("h-7 rounded-full border px-2.5 text-[12px] font-medium", days === d ? "border-accent bg-accent text-accent-foreground" : "border-line bg-surface text-secondary")}
            >
              {label}
            </button>
          ))}
        </div>
        <Button size="sm" variant="primary" loading={pending} onClick={save}>
          Schedule
        </Button>
      </div>
    </div>
  );
}
