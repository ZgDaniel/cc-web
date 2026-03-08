// CC-Web Service Worker — handles push notifications on mobile
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    event.waitUntil(
      self.registration.showNotification(event.data.title || 'CC-Web', {
        body: event.data.body || '',
        icon: event.data.icon || undefined,
        tag: 'cc-web-task',
        renotify: true,
        data: event.data.data || {},
      })
    );
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow('/');
    })
  );
});
