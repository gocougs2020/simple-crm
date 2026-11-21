"use client";

import { useEffect } from "react";
import { captureInstallPrompt } from "@/components/pwa/install-prompt";
import { registerServiceWorker } from "@/lib/push/client";

/** Registers the service worker once per page load, so the CRM can be installed and receive notifications, and keeps the browser's install offer for the sign-in page. */
export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    registerServiceWorker().catch((err) => console.warn("[pwa] service worker", err));
  }, []);
  useEffect(() => captureInstallPrompt(), []);
  return null;
}
