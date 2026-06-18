// Custom push handler injected into the workbox-generated service worker
// via vite-plugin-pwa workbox.importScripts.

self.addEventListener("push", (event) => {
  let payload = { title: "Pocket Agent", body: "", sessionId: undefined };
  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      payload.body = event.data.text();
    }
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icon-192.svg",
      badge: "/icon-192.svg",
      tag: payload.sessionId || "agent-cockpit",
      data: { sessionId: payload.sessionId },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const sessionId = event.notification.data?.sessionId;
  const url = sessionId ? `/session/${sessionId}` : "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        // Focus an existing window if one is open
        for (const client of clients) {
          if ("focus" in client) {
            client.navigate(url);
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(url);
        }
      }),
  );
});
