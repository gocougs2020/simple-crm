"use client";

import clsx from "clsx";
import { useEffect, useState, useTransition } from "react";
import { BellAlertIcon, BellSlashIcon, ComputerDesktopIcon, DevicePhoneMobileIcon } from "@heroicons/react/24/outline";
import { removeDevice, sendAgendaPreview, sendTestNotification, setDeviceAlerts, setEmailDigests } from "@/actions/notifications";
import { enablePush } from "@/components/push/enable-push";
import { useApp } from "@/components/app-context";
import { StatusBadge, type Tone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { emailDigestKinds, emailDigestLabels, notificationGroups, notificationKinds, notificationLabels, type EmailDigestKind, type NotificationKind } from "@/lib/constants";
import { formatAgo } from "@/lib/format";
import { morningHour } from "@/lib/notifications/schedule";
import { currentSubscription, isIos, isStandalone, pushSupported } from "@/lib/push/client";
import { Section } from "./nav";

type Device = { id: string; endpoint: string; label: string; alerts: NotificationKind[]; createdAt: string; lastSentAt: string | null };
type Support = "checking" | "unsupported" | "ios-install" | "denied" | "ready";

/**
 * Settings → Notifications: whether push is on for this browser or installed
 * app (and a button to ask the browser for permission), which alerts each
 * device gets, a test, and removing old devices.
 */
export function NotificationSettings({ publicKey, devices }: { publicKey: string | null; devices: Device[] }) {
  const { workspace, isAdmin } = useApp();
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
      const r = await enablePush(publicKey);
      if (!r.ok) {
        if (r.denied) setSupport("denied");
        return void toast.error(r.error);
      }
      setEndpoint(r.endpoint);
      toast.success("Notifications are on for this device. Pick the alerts you want below.");
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

  const test = () =>
    start(async () => {
      const r = await sendTestNotification();
      if (r.ok) toast.success(r.data.delivered === 1 ? "Test sent. It should arrive in a few seconds." : `Test sent to ${r.data.delivered} devices.`);
      else toast.error(r.error);
    });

  const others = devices.filter((d) => d !== thisDevice);
  const status = deviceStatus(support, !!publicKey, !!thisDevice);

  return (
    <>
      <Section title="Push notifications" description={`Alerts from ${workspace.name}'s CRM on this browser, or on your phone once the CRM is installed there. Each device has its own on/off and its own alerts.`}>
        <div className="flex flex-col gap-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2.5">
              {thisDevice ? <BellAlertIcon className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden /> : <BellSlashIcon className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />}
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-[14px] font-medium text-primary">
                  On this device
                  <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                </p>
                <p className="mt-0.5 text-[13px] text-secondary" aria-live="polite">
                  {status.detail(isAdmin)}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {thisDevice ? (
                <>
                  <Button size="sm" onClick={test} loading={pending}>
                    Send a test
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => turnOff(thisDevice)} disabled={pending}>
                    Turn off
                  </Button>
                </>
              ) : support === "ready" && publicKey ? (
                <Button variant="primary" onClick={turnOn} loading={pending}>
                  <BellAlertIcon aria-hidden />
                  Turn on notifications
                </Button>
              ) : null}
            </div>
          </div>
          {support === "ios-install" ? (
            <ol className="ml-7 list-decimal pl-4 text-[13px] text-secondary">
              <li>In Safari, tap Share, then Add to Home Screen.</li>
              <li>Open the CRM from its new icon and sign in.</li>
              <li>Come back to Settings → Notifications and tap Turn on notifications.</li>
            </ol>
          ) : null}
          {support === "ready" && !thisDevice && publicKey && !isIos() && /Android/.test(navigator.userAgent) && !isStandalone() ? (
            <p className="ml-7 text-[12.5px] text-muted">Tip: install the CRM from your browser&apos;s menu (Install app or Add to Home screen), so alerts open it full screen.</p>
          ) : null}
        </div>
        {thisDevice ? (
          <div className="border-t border-line p-5">
            <DeviceAlerts key={thisDevice.alerts.join()} device={thisDevice} />
          </div>
        ) : null}
      </Section>

      {others.length ? (
        <Section title="Other devices" description="Browsers and phones where you turned notifications on. Each keeps its own alerts. Remove the ones you don't use anymore.">
          <ul className="divide-y divide-line">
            {others.map((d) => (
              <li key={d.id} className="p-5">
                <OtherDevice device={d} pending={pending} tz={workspace.timezone} onRemove={turnOff} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <EmailDigests />
    </>
  );
}

type Status = { label: string; tone: Tone; detail: (isAdmin: boolean) => string };

function deviceStatus(support: Support, configured: boolean, on: boolean): Status {
  if (support === "checking") return { label: "Checking", tone: "neutral", detail: () => "Checking this browser…" };
  if (on) return { label: "On", tone: "success", detail: () => "This device gets the alerts you pick below." };
  if (support === "unsupported") return { label: "Not available", tone: "neutral", detail: () => "This browser can't receive push notifications. Recent Chrome, Edge, Firefox and Safari can." };
  if (support === "ios-install") return { label: "Install first", tone: "info", detail: () => "On iPhone and iPad, notifications only work in the CRM installed on your Home Screen." };
  if (support === "denied") return { label: "Blocked", tone: "error", detail: () => "Notifications are blocked for this site. Allow them in your browser's site settings, then reload this page." };
  if (!configured)
    return {
      label: "Not set up",
      tone: "warning",
      detail: (admin) => (admin ? "Push needs VAPID keys on this deployment. Add VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (docs/DEPLOYING.md), then redeploy." : "Push isn't set up on this deployment yet. Ask an admin to add it."),
    };
  return { label: "Off", tone: "neutral", detail: () => "Turn it on and your browser will ask whether to allow notifications." };
}

/** A device's alerts, grouped, each a switch. Saved as soon as it's flipped. Keyed by its saved alerts, so it starts over when they change elsewhere. */
function DeviceAlerts({ device }: { device: Device }) {
  const [alerts, setAlerts] = useState(device.alerts);
  const [pending, start] = useTransition();

  const save = (next: NotificationKind[]) => {
    const before = alerts;
    setAlerts(next);
    start(async () => {
      const r = await setDeviceAlerts(device.id, next);
      if (!r.ok) {
        setAlerts(before);
        toast.error(r.error);
      }
    });
  };
  const toggle = (kind: NotificationKind, on: boolean) => save(on ? [...new Set([...alerts, kind])] : alerts.filter((k) => k !== kind));
  const setGroup = (kinds: NotificationKind[], on: boolean) => save(on ? [...new Set([...alerts, ...kinds])] : alerts.filter((k) => !kinds.includes(k)));

  return (
    <div className="flex flex-col gap-5" aria-busy={pending}>
      {notificationGroups.map((g) => {
        const allOn = g.kinds.every((k) => alerts.includes(k));
        return (
          <fieldset key={g.title}>
            <div className="mb-1.5 flex items-center justify-between gap-3">
              <legend className="text-[12.5px] font-semibold tracking-wide text-muted uppercase">{g.title}</legend>
              <button type="button" className="text-[12.5px] font-medium text-accent hover:underline" onClick={() => setGroup(g.kinds, !allOn)}>
                {allOn ? "Turn all off" : "Turn all on"}
              </button>
            </div>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {g.kinds.map((k) => (
                <li key={k}>
                  <AlertSwitch id={`${device.id}-${k}`} kind={k} on={alerts.includes(k)} onChange={(on) => toggle(k, on)} />
                </li>
              ))}
            </ul>
          </fieldset>
        );
      })}
    </div>
  );
}

function AlertSwitch({ id, kind, on, onChange }: { id: string; kind: NotificationKind; on: boolean; onChange: (on: boolean) => void }) {
  const { label, hint } = notificationLabels[kind];
  return (
    <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
      <div className="min-w-0">
        <p id={`${id}-label`} className="text-[14px] text-primary">
          {label}
        </p>
        <p id={`${id}-hint`} className="mt-0.5 text-[12px] text-muted">
          {hint}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-hint`}
        onClick={() => onChange(!on)}
        className={clsx("relative h-5 w-9 shrink-0 rounded-full border transition-colors before:absolute before:-inset-2.5 before:content-['']", on ? "border-accent bg-accent" : "border-line-strong bg-sunken")}
      >
        <span className={clsx("absolute top-0.5 size-3.5 rounded-full bg-surface shadow-sm transition-[left]", on ? "left-[1.125rem]" : "left-0.5")} />
      </button>
    </div>
  );
}

function OtherDevice({ device, pending, tz, onRemove }: { device: Device; pending: boolean; tz: string; onRemove: (d: Device) => void }) {
  const Icon = /iPhone|iPad|Android/.test(device.label) ? DevicePhoneMobileIcon : ComputerDesktopIcon;
  const n = device.alerts.length;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon className="size-5 shrink-0 text-muted" aria-hidden />
          <div className="min-w-0">
            <p className="text-[14px] font-medium text-primary">{device.label}</p>
            <p className="text-[12.5px] text-muted">
              {n === 0 ? "No alerts" : n === notificationKinds.length ? "All alerts" : `${n} of ${notificationKinds.length} alerts`} · {device.lastSentAt ? `last alert ${formatAgo(device.lastSentAt, tz)}` : `added ${formatAgo(device.createdAt, tz)}`}
            </p>
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={() => onRemove(device)} disabled={pending}>
          Remove
        </Button>
      </div>
      <details className="group">
        <summary className="cursor-pointer text-[13px] font-medium text-accent select-none">Choose alerts for this device</summary>
        <div className="mt-3">
          <DeviceAlerts key={device.alerts.join()} device={device} />
        </div>
      </details>
    </div>
  );
}

/** The daily and weekly agenda emails: on or off for this teammate, with a preview to see what they look like. */
function EmailDigests() {
  const { viewer, services } = useApp();
  const [wants, setWants] = useState({ daily: !!viewer.prefs.emailDigests?.daily, weekly: !!viewer.prefs.emailDigests?.weekly });
  const [pending, start] = useTransition();
  const toggle = (kind: EmailDigestKind, on: boolean) => {
    const next = { ...wants, [kind]: on };
    setWants(next);
    start(async () => {
      const r = await setEmailDigests(next);
      if (!r.ok) {
        setWants(wants);
        toast.error(r.error);
      }
    });
  };
  const preview = (kind: EmailDigestKind) =>
    start(async () => {
      const r = await sendAgendaPreview(kind);
      if (r.ok) toast.success(services.email ? `Sent to ${r.data.to}` : "Email isn't connected here, so the preview was printed to the server log.");
      else toast.error(r.error);
    });
  return (
    <Section title="Email" description={`A morning email with your meetings and tasks. It goes out around ${hourLabel(morningHour())} in the workspace's time zone, and not at all on days with nothing on it.`}>
      <ul className="divide-y divide-line">
        {emailDigestKinds.map((k) => (
          <li key={k} className="flex flex-wrap items-start justify-between gap-3 p-5">
            <div className="min-w-0 flex-1">
              <Checkbox label={emailDigestLabels[k].label} checked={wants[k]} disabled={pending} onChange={(e) => toggle(k, e.target.checked)} />
              <p className="mt-0.5 pl-6 text-[12px] text-muted">{emailDigestLabels[k].hint}</p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => preview(k)} disabled={pending}>
              Send me a preview
            </Button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
