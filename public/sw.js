'use strict';

/* Service worker minimal : cache du « shell » de l'app et repli réseau.
   Les données Todoist ne sont jamais mises en cache (ni le cookie de session). */

const CACHE = 'tri-v2';
const SHELL = ['/', '/login', '/styles.css', '/app.js', '/login.js', '/favicon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  // Ne jamais intercepter les appels API (session et données restent côté réseau).
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('/offline-shell', copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match('/offline-shell').then((r) => r || caches.match('/')))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request))
  );
});