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
  const max = (self.Notification && self.Notification.maxActions) || 0;
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      // Action buttons (Done / Snooze 1h / Tomorrow) where the platform supports them.
      actions: Array.isArray(data.actions) && max > 0 ? data.actions.slice(0, max) : undefined,
      data: { url: data.url || '/today', instanceId: data.instanceId || null, tag: data.tag || null, title },
    }),
  );
});

const ACTIONS = {
  done: { path: (id) => `/api/instances/${id}/complete`, body: {}, done: 'Marked done ✓' },
  snooze: { path: (id) => `/api/instances/${id}/snooze`, body: { minutes: 60 }, done: 'Snoozed for an hour' },
  tomorrow: { path: (id) => `/api/instances/${id}/tomorrow`, body: {}, done: 'Moved to tomorrow' },
};

/** Runs a notification action against the API without opening the app (session cookie + CSRF token). */
async function runAction(action, data) {
  const spec = ACTIONS[action];
  if (!spec || !data.instanceId) throw new Error('unknown action');
  const meRes = await fetch('/api/me', { credentials: 'same-origin' });
  if (!meRes.ok) throw new Error('signed out');
  const { csrfToken } = await meRes.json();
  const res = await fetch(spec.path(data.instanceId), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(spec.body),
  });
  if (!res.ok) throw new Error(`action failed (${res.status})`);
  // A quiet confirmation that replaces the reminder, then disappears.
  await self.registration.showNotification(data.title || 'CoWork', {
    body: spec.done,
    tag: data.tag || undefined,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    silent: true,
    data: { url: data.url || '/today' },
  });
  setTimeout(() => {
    self.registration.getNotifications({ tag: data.tag || undefined }).then((ns) => ns.forEach((n) => n.close()));
  }, 4000);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  if (event.action && ACTIONS[event.action]) {
    // Handled in the background; if it can't be (signed out, offline), open the todo instead.
    event.waitUntil(runAction(event.action, data).catch(() => openApp(data.url || '/today')));
    return;
  }
  event.waitUntil(openApp(data.url || '/today'));
});

function openApp(path) {
  const target = new URL(path, self.location.origin);
  if (target.origin !== self.location.origin) return Promise.resolve();
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
        return w.focus().then((f) => (f && 'navigate' in f ? f.navigate(target.href) : f));
      }
    }
    return self.clients.openWindow(target.href);
  });
}
