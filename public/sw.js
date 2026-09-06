/**
 * FleetSuite Service Worker — offline app shell + Web Push.
 *
 * Network-first for pages and static assets, falling back to cache when
 * the device is offline.
 *
 * API responses are NEVER cached or served from cache. They used to be,
 * and it printed a stale estimate: /api/estimates/<id>/pdf is a GET, so a
 * successful render was stored under that URL, and any later request that
 * failed or timed out — the PDF route inlines photos and can take a while
 * on a phone — silently served the OLD document. Nothing server-side ever
 * looked wrong, because nothing server-side WAS wrong. cache.put also
 * ignores Cache-Control, so the route's `no-store` did nothing to stop it.
 * A cached PDF handed to a customer as current is the failure this file
 * exists to not cause.
 */

const CACHE_NAME = 'fleetsuite-offline-v3';

// App shell: assets worth having offline. '/offline-scan' used to be listed
// here and no longer exists as a route — addAll rejects atomically on a 404,
// so install failed every time and the previously-activated worker could
// never be replaced OR have its stale cache cleaned. Entries are added
// individually now, so one missing file can't wedge the whole worker.
const APP_SHELL = [
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json',
];

// Install: pre-cache the app shell, tolerating individual misses.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => Promise.allSettled(
      APP_SHELL.map((url) => cache.add(url)),
    ))
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

// ═══════════ PUSH NOTIFICATIONS ═══════════

// Handle incoming push messages
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch {
    data = { title: 'BMG FleetSuite', body: event.data.text() };
  }

  const options = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'bmg-notification',
    data: { url: data.url || '/' },
    renotify: true,
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'BMG FleetSuite', options)
  );
});

// Handle notification click — open the app and navigate to the deep link.
// Safari's WindowClient does NOT implement .navigate() and Firefox can also
// reject it for uncontrolled clients, so we fall back to postMessage (handled
// by the app) and finally to opening a fresh window.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || '/';
  const origin = self.location.origin;
  const targetAbs = new URL(targetUrl, origin).href;

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const sameOrigin = allClients.filter((c) => {
      try { return new URL(c.url).origin === origin; } catch { return false; }
    });

    // 1. If a window is already on the target URL, just focus it.
    const exact = sameOrigin.find((c) => c.url === targetAbs);
    if (exact) {
      return exact.focus();
    }

    // 2. Otherwise, try to bring an existing window to the front and navigate it.
    for (const client of sameOrigin) {
      try {
        await client.focus();
      } catch {
        continue;
      }

      // navigate() works in Chromium and recent Firefox but is missing on Safari.
      if (typeof client.navigate === 'function') {
        try {
          await client.navigate(targetUrl);
          return;
        } catch {
          // fall through to postMessage
        }
      }

      // Safari path: tell the app to route itself via the message channel.
      try {
        client.postMessage({ type: 'NOTIFICATION_NAVIGATE', url: targetUrl });
      } catch {}
      return;
    }

    // 3. No same-origin window open — open a new one at the deep link.
    return self.clients.openWindow(targetUrl);
  })());
});

// ═══════════ OFFLINE CACHING ═══════════

/** Anything under /api/ is live data or a generated document. Never cached,
 *  never served from cache: a stale answer here is worse than no answer,
 *  and for a PDF it is a wrong document that looks right. */
function isApiRequest(url) {
  try {
    const u = new URL(url);
    return u.origin === self.location.origin && u.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

/** Responses that ask not to be stored. cache.put honours nothing on its
 *  own, so the check has to happen here. */
function isNoStore(response) {
  const cc = response.headers.get('Cache-Control') || '';
  return /no-store/i.test(cc);
}

// Fetch: network-first, fall back to cache
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Let API calls go straight to the network, unintercepted — no caching on
  // the way out, and no cached fallback on failure. A failed request has to
  // look like a failure so the caller can say so.
  if (isApiRequest(request.url)) return;

  // For navigation requests (page loads) and JS/CSS assets: network-first
  event.respondWith(
    fetch(request)
      .then((response) => {
        // Cache successful responses for offline use, unless the response
        // asked not to be stored.
        if (response.ok && !isNoStore(response)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, clone);
          });
        }
        return response;
      })
      .catch(() => {
        // Offline: serve from cache
        return caches.match(request).then((cached) => {
          if (cached) return cached;
          return new Response('Offline', { status: 503 });
        });
      })
  );
});
