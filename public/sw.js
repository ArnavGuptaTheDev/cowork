/* CoWork service worker: Web Push + a small offline fallback. API responses are never cached. */
const CACHE = 'cowork-v1';
const OFFLINE_URL = '/offline';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll([OFFLINE_URL, '/favicon.svg', '/icons/icon-192.png']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // Hashed build assets never change: cache-first.
  if (url.pathname.startsWith('/_astro/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Pages: network-first, falling back to the last copy, then the offline page.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match(OFFLINE_URL))),
    );
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'CoWork', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'CoWork';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      data: { url: data.url || '/today' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.url) || '/today';
  const target = new URL(path, self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
          return w.focus().then((f) => (f && 'navigate' in f ? f.navigate(target.href) : f));
        }
      }
      return self.clients.openWindow(target.href);
    }),
  );
});
