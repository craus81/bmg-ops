/**
 * FleetSuite Service Worker — Offline Scan Support + Push Notifications
 *
 * Caches the app shell and offline scan page so the scanner works
 * underground without cell service. Uses a network-first strategy
 * for most requests, falling back to cache when offline.
 *
 * Also handles Web Push notifications (Safari, Chrome, Firefox, Edge).
 */

const CACHE_NAME = 'fleetsuite-offline-v2';

// App shell: pages and assets needed for offline scanning
const APP_SHELL = [
  '/offline-scan',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.json',
];

// Install: pre-cache the app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL);
    })
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

// Fetch: network-first, fall back to cache
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // For navigation requests (page loads) and JS/CSS assets: network-first
  event.respondWith(
    fetch(request)
      .then((response) => {
        // Cache successful responses for offline use
        if (response.ok) {
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
          // If requesting a page and we don't have it cached, show offline-scan
          if (request.mode === 'navigate') {
            return caches.match('/offline-scan');
          }
          return new Response('Offline', { status: 503 });
        });
      })
  );
});
