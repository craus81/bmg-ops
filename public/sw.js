/**
 * FleetSuite Service Worker — Offline Scan Support
 *
 * Caches the app shell and offline scan page so the scanner works
 * underground without cell service. Uses a network-first strategy
 * for most requests, falling back to cache when offline.
 */

const CACHE_NAME = 'fleetsuite-offline-v1';

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
