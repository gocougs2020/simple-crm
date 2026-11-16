"use client";

import { useEffect } from "react";
import { registerServiceWorker } from "@/lib/push/client";

/** Registers the service worker once per page load, so the CRM can be installed and receive notifications. */
export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    registerServiceWorker().catch((err) => console.warn("[pwa] service worker", err));
  }, []);
  return null;
}
