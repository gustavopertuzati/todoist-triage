'use strict';

/* Service worker : réseau d'abord, cache en secours (mode hors-ligne limité).
   Les données Todoist ne sont jamais mises en cache (ni le cookie de session). */

const CACHE = 'tri-v5';
const SHELL = ['/', '/login', '/styles.css', '/schedule-settings.js', '/app.js', '/login.js', '/favicon.svg', '/manifest.webmanifest'];

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

// Réseau d'abord : on récupère toujours la version fraîche quand on est en ligne,
// et on retombe sur le cache uniquement si le réseau échoue (hors-ligne).
function networkFirst(request, fallbackKey) {
  return fetch(request)
    .then((response) => {
      if (response && response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
      }
      return response;
    })
    .catch(() =>
      caches.match(request).then((cached) => cached || caches.match(fallbackKey || '/'))
    );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  // Jamais d'interception des appels API (session et données restent au réseau).
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(networkFirst(request, request.mode === 'navigate' ? '/login' : '/'));
});
