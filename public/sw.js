/*
 * The CRM's service worker. It shows push notifications and opens the right
 * page when one is tapped. It doesn't cache pages: everything in the CRM is
 * behind a login and changes constantly, so the network is the source of truth.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: event.data ? event.data.text() : "" };
  }
  const title = data.title || "CRM";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/icon/192",
      badge: "/icon/192",
      // One notification per thing: a newer one about the same task replaces the old.
      tag: data.tag || undefined,
      renotify: !!data.tag,
      data: { url: typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // Reuse an open CRM tab or the installed app, rather than opening another.
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        await client.focus();
        if ("navigate" in client) await client.navigate(url).catch(() => {});
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});

// A fetch handler (even an empty one) keeps some browsers' install prompt available. Requests go to the network as usual.
self.addEventListener("fetch", () => {});
