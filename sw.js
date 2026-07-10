self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  self.registration.showNotification(data.title || 'La Cave', {
    body: data.body || '',
    icon: '/la-cave/icon.png',
    badge: '/la-cave/icon.png'
  });
});
