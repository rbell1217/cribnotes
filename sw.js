/**
 * CribNotes Service Worker
 *
 * Provides:
 *   - App-shell caching so the sitter view loads in low-signal areas
 *   - Network-first strategy for Firestore/Storage; cache-first for static
 *   - Web Push handling with click-through to the right shift/child
 *
 * Bumped CACHE_VERSION when shipping new versions to invalidate old assets.
 */

const CACHE_VERSION = 'cribnotes-v11';
// js/config.js is intentionally NOT in the shell -- it holds Firebase
// credentials and must always be fetched fresh so config changes take effect
// without forcing the user to clear their cache.
const APP_SHELL = [
  './',
  './index.html',
  './app.html',
  './css/styles.css',
  './js/app.js',
  './js/auth.js',
  './js/database.js',
  './js/dictation.js',
  './js/textProcessor.js',
  './js/context.js',
  './js/shift.js',
  './js/medication.js',
  './js/notifications.js',
  './manifest.json'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(APP_SHELL).catch(() => {}))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET
  if (event.request.method !== 'GET') return;

  // Skip Firebase / Google APIs - these need fresh data and have their own offline support
  if (
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('firebase.com') ||
    url.hostname.includes('firebaseapp.com')
  ) {
    return;
  }

  // App shell + same-origin: cache-first, fall back to network, fall back to offline shell.
  // EXCEPTION: js/config.js holds Firebase credentials and must always be fetched
  // fresh so changes take effect immediately without requiring a cache wipe.
  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith('/js/config.js')) {
      event.respondWith(
        fetch(event.request).catch(() => caches.match(event.request))
      );
      return;
    }
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request)
          .then(response => {
            if (response.ok && response.type === 'basic') {
              const clone = response.clone();
              caches.open(CACHE_VERSION).then(cache => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => caches.match('./app.html').then(r => r || caches.match('./index.html')));
      })
    );
    return;
  }

  // Cross-origin: network with cache fallback
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

/**
 * Push handler - server payloads should be JSON of shape:
 * { title, body, tag, data: { childId, shiftId, type } }
 */
self.addEventListener('push', event => {
  let payload = { title: 'CribNotes', body: 'New update' };
  try {
    if (event.data) payload = event.data.json();
  } catch (e) {
    payload.body = event.data?.text?.() || payload.body;
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body || '',
      icon: payload.icon || './icon-192.png',
      badge: payload.badge || './icon-192.png',
      tag: payload.tag || 'cribnotes',
      data: payload.data || {},
      vibrate: [200, 100, 200],
      requireInteraction: payload.requireInteraction || false
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      for (const c of clients) {
        if ('focus' in c) {
          c.postMessage({ type: 'notification-click', data });
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
