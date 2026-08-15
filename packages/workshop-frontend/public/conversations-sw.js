// Service worker for conversation notifications. Payloads are small JSON hints produced by the
// Microsoft gatekeeper's ChatMirror; clicking focuses (or opens) the conversation.

self.addEventListener('push', (event) => {
  let payload = { title: 'New message', body: '', refKey: null };
  try {
    payload = { ...payload, ...event.data.json() };
  } catch {}
  event.waitUntil(self.registration.showNotification(payload.title, {
    body: payload.body,
    tag: payload.refKey || undefined,
    data: { refKey: payload.refKey },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const refKey = event.notification.data && event.notification.data.refKey;
  const url = refKey ? '/conversations?c=' + encodeURIComponent(refKey) : '/conversations';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.focus();
        await client.navigate(url);
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
