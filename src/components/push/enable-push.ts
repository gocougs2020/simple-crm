"use client";

import { subscribeDevice } from "@/actions/notifications";
import { isStandalone, keyBytes, registerServiceWorker } from "@/lib/push/client";

export type EnableResult = { ok: true; endpoint: string } | { ok: false; error: string; denied?: boolean };

/**
 * Asks the browser for permission, signs this device up with its push service
 * and saves it for the signed-in teammate. iPhones only show the permission
 * prompt from a tap, so call this from a click handler.
 */
export async function enablePush(publicKey: string | null): Promise<EnableResult> {
  if (!publicKey) return { ok: false, error: "Push notifications aren't set up on this deployment yet. An admin can add VAPID keys." };
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return { ok: false, denied: permission === "denied", error: "Notifications are blocked for this site. Allow them in your browser's site settings, then try again." };
  }
  try {
    const reg = await registerServiceWorker();
    await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
    const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
    const r = await subscribeDevice(json, { standalone: isStandalone() });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, endpoint: sub.endpoint };
  } catch (err) {
    console.error("[push] subscribe", err);
    return { ok: false, error: "This device couldn't sign up for notifications. Reload the page and try again." };
  }
}
