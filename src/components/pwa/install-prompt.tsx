"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { ArrowDownTrayIcon, ArrowUpOnSquareIcon, EllipsisVerticalIcon, PlusCircleIcon } from "@heroicons/react/24/outline";
import { Button } from "@/components/ui/button";
import { isIos, isStandalone } from "@/lib/push/client";
import { dismissedRecently, PromptCard, rememberDismissed } from "./prompt-card";

/** Chrome and Edge on Android offer their own install dialog; this is the event that opens it. */
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn));
const setOffer = (e: InstallEvent | null) => {
  deferred = e;
  listeners.forEach((fn) => fn());
};

/**
 * Keeps the browser's install offer for later. Called once per page load
 * (pwa-register.tsx) so the offer isn't missed while the page is still loading.
 */
export function captureInstallPrompt() {
  const onPrompt = (e: Event) => {
    e.preventDefault();
    setOffer(e as InstallEvent);
  };
  const onInstalled = () => setOffer(null);
  window.addEventListener("beforeinstallprompt", onPrompt);
  window.addEventListener("appinstalled", onInstalled);
  return () => {
    window.removeEventListener("beforeinstallprompt", onPrompt);
    window.removeEventListener("appinstalled", onInstalled);
  };
}

const DISMISSED = "crm:install-prompt-dismissed";
type Platform = "ios" | "android";

/**
 * On a phone's browser (not the installed app), a card at the bottom of the
 * sign-in page explains how to add the CRM to the Home Screen. Installed, it
 * opens full screen and can get push notifications, which iPhones only allow
 * for installed apps. Closing it hides it for two weeks.
 */
export function InstallPrompt() {
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [steps, setSteps] = useState(false);
  const offer = useSyncExternalStore(
    subscribe,
    () => deferred,
    () => null,
  );

  useEffect(() => {
    if (isStandalone() || dismissedRecently(DISMISSED, 14)) return;
    const p: Platform | null = isIos() ? "ios" : /Android/i.test(navigator.userAgent) ? "android" : null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the platform is only known in the browser
    setPlatform(p);
  }, []);

  if (!platform) return null;

  const close = () => {
    rememberDismissed(DISMISSED);
    setPlatform(null);
  };
  const install = async () => {
    if (!offer) return;
    // An offer opens once: afterwards the card shows the steps from the browser's menu instead.
    setOffer(null);
    try {
      await offer.prompt();
      if ((await offer.userChoice).outcome === "accepted") setPlatform(null);
    } catch (err) {
      console.warn("[pwa] install", err);
      setSteps(true);
    }
  };

  const howTo =
    platform === "ios" ? (
      <ol className="mt-3 flex flex-col gap-2.5">
        <Step n={1}>
          Tap <Glyph icon={<ArrowUpOnSquareIcon />} /> Share. In Safari, it&apos;s in the <Glyph icon={<span className="text-[15px] leading-none font-bold">···</span>} /> More menu next to the address bar.
        </Step>
        <Step n={2}>
          Tap <Glyph icon={<PlusCircleIcon />} /> <strong className="font-medium text-primary">Add to Home Screen</strong>. Scroll down the list if you don&apos;t see it.
        </Step>
        <Step n={3}>Keep Open as Web App on, then tap Add. Open the CRM from its new icon and sign in.</Step>
      </ol>
    ) : (
      <ol className="mt-3 flex flex-col gap-2.5">
        <Step n={1}>
          Open your browser&apos;s menu <Glyph icon={<EllipsisVerticalIcon />} />.
        </Step>
        <Step n={2}>
          Tap <strong className="font-medium text-primary">Install app</strong> or <strong className="font-medium text-primary">Add to Home screen</strong>.
        </Step>
        <Step n={3}>Open the CRM from its new icon and sign in.</Step>
      </ol>
    );

  return (
    <>
      {/* Room to scroll the form clear of the card. */}
      <div aria-hidden className={steps ? "h-80" : "h-44"} />
      <PromptCard title="Install the CRM on this phone" icon={<ArrowDownTrayIcon />} onDismiss={close}>
        <p>It opens full screen like an app and can send you notifications for tasks, mentions and replies.</p>
        {steps ? howTo : null}
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Not now
          </Button>
          {offer ? (
            <Button variant="primary" onClick={install}>
              <ArrowDownTrayIcon aria-hidden />
              Install
            </Button>
          ) : !steps ? (
            <Button variant="primary" onClick={() => setSteps(true)}>
              Show me how
            </Button>
          ) : null}
        </div>
      </PromptCard>
    </>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5 text-[13.5px] leading-snug">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-sunken text-[11.5px] font-semibold text-primary tabular-nums">{n}</span>
      <span className="min-w-0 pt-px">{children}</span>
    </li>
  );
}

/** An inline picture of the button to look for. */
function Glyph({ icon }: { icon: React.ReactNode }) {
  return (
    <span aria-hidden className="mx-0.5 inline-flex size-6 items-center justify-center rounded-md border border-line bg-canvas align-middle text-primary [&_svg]:size-4">
      {icon}
    </span>
  );
}
