self.addEventListener('push', event => {
  const data = event.data?.json() || {};
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

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
