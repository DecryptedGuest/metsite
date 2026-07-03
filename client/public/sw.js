// sw.js — IACMS service worker (push notifications)
self.addEventListener('push', function (e) {
  var data = {};
  try { data = e.data.json(); } catch (_) {}

  var title   = data.title || 'IACMS';
  var options = {
    body:  data.body  || 'New activity requires your attention.',
    icon:  '/img/logo.png',
    badge: '/img/logo.png',
    data:  { url: data.url || '/ia/dashboard' },
    requireInteraction: true,
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var target = e.notification.data && e.notification.data.url
    ? e.notification.data.url
    : '/ia/dashboard';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (wins) {
      // If the site is already open, focus it and navigate to the target page
      for (var i = 0; i < wins.length; i++) {
        var w = wins[i];
        if (w.url.includes(self.location.origin)) {
          w.postMessage({ type: 'PUSH_NAV', url: target });
          return w.focus();
        }
      }
      // Otherwise open a new window
      return clients.openWindow(self.location.origin + target);
    })
  );
});
