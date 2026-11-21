"use client";

import { useEffect, useState, useTransition } from "react";
import { BellAlertIcon } from "@heroicons/react/24/outline";
import { useApp } from "@/components/app-context";
import { enablePush } from "@/components/push/enable-push";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { currentSubscription, isStandalone, pushSupported } from "@/lib/push/client";
import { dismissedRecently, PromptCard, rememberDismissed } from "./prompt-card";

const DISMISSED = "crm:notifications-prompt-dismissed";

/**
 * In the CRM installed on a phone's Home Screen, asks once to turn on
 * notifications for this device, until it's on, blocked, or closed (then
 * again after a week). iPhones only show the permission dialog after a tap,
 * so this asks with a button rather than on load. Settings → Notifications
 * picks which alerts arrive.
 */
export function NotificationsPrompt() {
  const { services } = useApp();
  const publicKey = services.pushKey;
  const [show, setShow] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!publicKey || !isStandalone() || !pushSupported() || Notification.permission === "denied" || dismissedRecently(DISMISSED, 7)) return;
    let live = true;
    currentSubscription()
      .catch(() => null)
      .then((sub) => live && !sub && setShow(true));
    return () => {
      live = false;
    };
  }, [publicKey]);

  if (!show) return null;

  const close = () => {
    rememberDismissed(DISMISSED);
    setShow(false);
  };
  const turnOn = () =>
    start(async () => {
      const r = await enablePush(publicKey);
      if (!r.ok) {
        if (r.denied) setShow(false);
        return void toast.error(r.denied ? "Notifications are blocked. To get them, allow notifications for the CRM in your phone's Settings." : r.error);
      }
      setShow(false);
      toast.success("Notifications are on for this phone. Pick which ones you get in Settings → Notifications.");
    });

  return (
    <PromptCard title="Turn on notifications" icon={<BellAlertIcon />} onDismiss={close}>
      <p>Get an alert on this phone when a task is due, someone mentions you, or a client replies.</p>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={close} disabled={pending}>
          Not now
        </Button>
        <Button variant="primary" onClick={turnOn} loading={pending}>
          <BellAlertIcon aria-hidden />
          Turn on
        </Button>
      </div>
    </PromptCard>
  );
}
