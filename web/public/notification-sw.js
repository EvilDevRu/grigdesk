// Дополнение к сгенерированному Workbox service worker: уведомление должно не просто
// закрыться по нажатию, а вернуть человека в то окно/маршрут кокпита, где оно возникло.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.registration.scope).href;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => client.url.startsWith(self.registration.scope));
    if (existing) {
      try {
        const client = typeof existing.navigate === 'function'
          ? await existing.navigate(target)
          : existing;
        return client?.focus();
      } catch {
        return existing.focus();
      }
    }
    return self.clients.openWindow?.(target);
  })());
});
