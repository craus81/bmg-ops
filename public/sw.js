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

// Handle notification click — open the app and navigate to the deep link
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // If app is already open, focus it and navigate
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          client.focus();
          client.navigate(targetUrl);
          return;
        }
      }
      // Otherwise open a new window
      return self.clients.openWindow(targetUrl);
    })
  );
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
