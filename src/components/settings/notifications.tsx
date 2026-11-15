"use client";

import { useEffect, useState, useTransition } from "react";
import { BellAlertIcon, DevicePhoneMobileIcon, ComputerDesktopIcon } from "@heroicons/react/24/outline";
import { removeDevice, sendTestNotification, setDeviceAlerts, subscribeDevice } from "@/actions/notifications";
import { useApp } from "@/components/app-context";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { notificationKinds, notificationLabels, type NotificationKind } from "@/lib/constants";
import { formatAgo } from "@/lib/format";
import { currentSubscription, isIos, isStandalone, keyBytes, pushSupported, registerServiceWorker } from "@/lib/push/client";
import { Section } from "./nav";

type Device = { id: string; endpoint: string; label: string; alerts: NotificationKind[]; createdAt: string; lastSentAt: string | null };
type Support = "checking" | "unsupported" | "ios-install" | "denied" | "ready";

/**
 * Settings → Notifications: turn push on for this browser or installed app,
 * pick which alerts each device gets, send a test, and remove old devices.
 */
export function NotificationSettings({ publicKey, devices }: { publicKey: string | null; devices: Device[] }) {
  const { workspace } = useApp();
  const [support, setSupport] = useState<Support>("checking");
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    (async () => {
      const state: Support = !pushSupported() ? (isIos() && !isStandalone() ? "ios-install" : "unsupported") : Notification.permission === "denied" ? "denied" : "ready";
      const sub = state === "ready" ? await currentSubscription().catch(() => null) : null;
      if (!live) return;
      setSupport(state);
      setEndpoint(sub?.endpoint ?? null);
    })();
    return () => {
      live = false;
    };
  }, []);

  const thisDevice = devices.find((d) => d.endpoint === endpoint) ?? null;

  const turnOn = () =>
    start(async () => {
      if (!publicKey) return void toast.error("Push notifications aren't set up on this deployment yet. An admin can add VAPID keys.");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setSupport(permission === "denied" ? "denied" : "ready");
        return void toast.error("Notifications are blocked for this site. Allow them in your browser's site settings, then try again.");
      }
      try {
        const reg = await registerServiceWorker();
        await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
        const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
        const r = await subscribeDevice(json, { standalone: isStandalone() });
        if (!r.ok) return void toast.error(r.error);
        setEndpoint(sub.endpoint);
        toast.success("Notifications are on for this device");
      } catch (err) {
        console.error("[push] subscribe", err);
        toast.error("This device couldn't sign up for notifications. Reload the page and try again.");
      }
    });

  const turnOff = (device: Device) =>
    start(async () => {
      if (device.endpoint === endpoint) {
        const sub = await currentSubscription().catch(() => null);
        await sub?.unsubscribe().catch(() => {});
        setEndpoint(null);
      }
      const r = await removeDevice(device.id);
      if (!r.ok) toast.error(r.error);
      else toast.success(device.endpoint === endpoint ? "Notifications are off for this device" : `Removed ${device.label}`);
    });

  const toggle = (device: Device, kind: NotificationKind, on: boolean) =>
    start(async () => {
      const next = on ? [...new Set([...device.alerts, kind])] : device.alerts.filter((k) => k !== kind);
      const r = await setDeviceAlerts(device.id, next);
      if (!r.ok) toast.error(r.error);
    });

  const test = () =>
    start(async () => {
      const r = await sendTestNotification();
      if (r.ok) toast.success(r.data.delivered === 1 ? "Test sent. It should arrive in a few seconds." : `Test sent to ${r.data.delivered} devices.`);
      else toast.error(r.error);
    });

  const others = devices.filter((d) => d !== thisDevice);

  return (
    <>
      <Section
        title="This device"
        description={`Get alerts from ${workspace.name}'s CRM on this browser, or on your phone once it's installed. Each device has its own alerts.`}
        action={devices.length ? <Button size="sm" onClick={test} loading={pending}>Send a test</Button> : null}
      >
        <div className="flex flex-col gap-3 p-5">
          {support === "checking" ? <p className="text-[13.5px] text-muted">Checking this browser…</p> : null}
          {support === "unsupported" ? <p className="text-[13.5px] text-secondary">This browser can&apos;t receive push notifications. Recent Chrome, Edge, Firefox and Safari can.</p> : null}
          {support === "ios-install" ? (
            <div className="text-[13.5px] text-secondary">
              <p className="font-medium text-primary">Add the CRM to your Home Screen first</p>
              <p className="mt-1">On iPhone and iPad, notifications only work in the installed app. In Safari, tap Share, then Add to Home Screen. Open the CRM from its new icon and come back here.</p>
            </div>
          ) : null}
          {support === "denied" ? <p className="text-[13.5px] text-secondary">Notifications are blocked for this site. Allow them in your browser&apos;s site settings, then reload this page.</p> : null}
          {support === "ready" && !thisDevice ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-[13.5px] text-secondary">Notifications are off on this device.</p>
              <Button variant="primary" onClick={turnOn} loading={pending}>
                <BellAlertIcon aria-hidden />
                Turn on notifications
              </Button>
            </div>
          ) : null}
          {support === "ready" && thisDevice ? <DeviceRow device={thisDevice} current pending={pending} tz={workspace.timezone} onToggle={toggle} onRemove={turnOff} /> : null}
        </div>
      </Section>

      {others.length ? (
        <Section title="Other devices" description="Browsers and phones where you turned notifications on. Remove the ones you don't use anymore.">
          <ul className="divide-y divide-line">
            {others.map((d) => (
              <li key={d.id} className="p-5">
                <DeviceRow device={d} pending={pending} tz={workspace.timezone} onToggle={toggle} onRemove={turnOff} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </>
  );
}

function DeviceRow({ device, current, pending, tz, onToggle, onRemove }: { device: Device; current?: boolean; pending: boolean; tz: string; onToggle: (d: Device, k: NotificationKind, on: boolean) => void; onRemove: (d: Device) => void }) {
  const Icon = /iPhone|iPad|Android/.test(device.label) ? DevicePhoneMobileIcon : ComputerDesktopIcon;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon className="size-5 shrink-0 text-muted" aria-hidden />
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-[14px] font-medium text-primary">
              {device.label}
              {current ? <StatusBadge tone="success">On</StatusBadge> : null}
            </p>
            <p className="text-[12.5px] text-muted">{device.lastSentAt ? `Last alert ${formatAgo(device.lastSentAt, tz)}` : `Added ${formatAgo(device.createdAt, tz)}`}</p>
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={() => onRemove(device)} disabled={pending}>
          {current ? "Turn off" : "Remove"}
        </Button>
      </div>
      <fieldset className="grid gap-2.5 sm:grid-cols-2" disabled={pending}>
        <legend className="sr-only">Alerts on {device.label}</legend>
        {notificationKinds.map((k) => (
          <div key={k}>
            <Checkbox label={notificationLabels[k].label} checked={device.alerts.includes(k)} onChange={(e) => onToggle(device, k, e.target.checked)} />
            <p className="mt-0.5 pl-6 text-[12px] text-muted">{notificationLabels[k].hint}</p>
          </div>
        ))}
      </fieldset>
    </div>
  );
}
