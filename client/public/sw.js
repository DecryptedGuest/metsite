// sw.js — MET Portal service worker: push notifications + PWA install/offline.
var CACHE = 'met-portal-v3';
var SHELL = ['/img/divisions/met.png', '/css/main.css', '/css/dashboard.css', '/js/ui.js'];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL).catch(function () {}); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

// Network-first for same-origin GETs (never touch API/auth/handoff). Falls back
// to cache when offline so the installed app still opens; failed navigations get
// a minimal offline page.
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname.startsWith('/mobile/')) return;

  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok && (url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/') || url.pathname.startsWith('/img/'))) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        if (hit) return hit;
        if (req.mode === 'navigate') return new Response('<h1 style="font-family:sans-serif;text-align:center;margin-top:20vh;">You are offline</h1>', { headers: { 'Content-Type': 'text/html' } });
        return new Response('', { status: 504 });
      });
    })
  );
});

self.addEventListener('push', function (e) {
  var data = {};
  try { data = e.data.json(); } catch (_) {}
  var title   = data.title || 'MET Portal';
  var options = {
    body:  data.body  || 'New activity requires your attention.',
    icon:  data.icon  || '/img/divisions/met.png',
    badge: '/img/divisions/met.png',
    data:  data, // keep url + optional viewUrl/claimUrl for the action buttons
    requireInteraction: !!data.requireInteraction,
    tag:   data.tag || undefined,
    // Action buttons (e.g. "Claim ticket" / "Go to ticket") + a buzz on mobile.
    actions:  Array.isArray(data.actions) ? data.actions.slice(0, 2) : undefined,
    vibrate:  Array.isArray(data.vibrate) ? data.vibrate : undefined,
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var d = e.notification.data || {};
  // The tapped action button picks the destination; a plain body tap uses url.
  var target = d.url || '/profile';
  if (e.action === 'view' && d.viewUrl) target = d.viewUrl;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (wins) {
        for (var i = 0; i < wins.length; i++) {
          var w = wins[i];
          if (w.url.includes(self.location.origin)) {
            w.postMessage({ type: 'PUSH_NAV', url: target });
            return w.focus();
          }
        }
        return clients.openWindow(self.location.origin + target);
      })
  );
});
