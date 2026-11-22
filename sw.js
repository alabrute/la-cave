self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch { data = { body: event.data?.text() || '' }; }
  event.waitUntil(
    self.registration.showNotification(data.title || 'La Cave 🍷', {
      body: data.body || '',
      icon: '/la-cave/icon-192.png',
      badge: '/la-cave/icon-192.png',
      vibrate: [200, 100, 200],
      data: { url: 'https://alabrute.github.io/la-cave/' }
    })
  );
});

// Clic sur la notification : revenir sur l'appli si elle est ouverte, sinon l'ouvrir
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = wins.find(w => w.url.startsWith(event.notification.data.url));
    if (existing) return existing.focus();
    return clients.openWindow(event.notification.data.url);
  })());
});
