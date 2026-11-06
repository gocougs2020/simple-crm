"use client";

import clsx from "clsx";
import { CheckCircleIcon, ExclamationTriangleIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { useEffect, useSyncExternalStore } from "react";

type Toast = { id: number; tone: "success" | "error"; message: string; action?: { label: string; onClick: () => void } };

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function push(t: Omit<Toast, "id">) {
  const id = nextId++;
  toasts = [...toasts.slice(-3), { ...t, id }];
  emit();
  return id;
}

export function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** Confirms an action ("Call logged"), optionally with Undo; errors say what to do next. */
export const toast = {
  success: (message: string, action?: Toast["action"]) => push({ tone: "success", message, action }),
  error: (message: string) => push({ tone: "error", message }),
};

export function Toaster() {
  const list = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => toasts,
    () => toasts,
  );
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[70] flex flex-col items-center gap-2 p-4 sm:items-end" aria-live="polite">
      {list.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastItem({ toast: t }: { toast: Toast }) {
  useEffect(() => {
    const timer = setTimeout(() => dismiss(t.id), t.tone === "error" ? 8000 : t.action ? 6000 : 3500);
    return () => clearTimeout(timer);
  }, [t]);
  const Icon = t.tone === "success" ? CheckCircleIcon : ExclamationTriangleIcon;
  return (
    <div
      role={t.tone === "error" ? "alert" : "status"}
      className={clsx(
        "pointer-events-auto flex w-full max-w-sm animate-slide-up items-center gap-2.5 rounded-lg px-3.5 py-2.5 text-[13px] font-medium text-white shadow-lg",
        t.tone === "success" ? "bg-primary" : "bg-error",
      )}
    >
      <Icon className={clsx("size-4 shrink-0", t.tone === "success" ? "text-toast-success-icon" : "text-white")} aria-hidden />
      <span className="min-w-0 flex-1">{t.message}</span>
      {t.action ? (
        <button
          type="button"
          className="rounded px-1.5 py-0.5 font-semibold underline-offset-2 hover:underline"
          onClick={() => {
            t.action!.onClick();
            dismiss(t.id);
          }}
        >
          {t.action.label}
        </button>
      ) : null}
      <button type="button" className="-mr-1 rounded p-0.5 text-white/60 hover:text-white" onClick={() => dismiss(t.id)} aria-label="Dismiss">
        <XMarkIcon className="size-4" />
      </button>
    </div>
  );
}
