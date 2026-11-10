// Load cpuProbe() from avx-probe.js. importScripts() must run during the
// service worker's initial evaluation, so the import sits at the top level.
importScripts('avx-probe.js');

// Bump this version to roll out a new cache and evict the old one.
const CACHE = 'self-serving-v2';

// The app shell: everything needed to render the site offline.
const ASSETS = [
  './',
  './index.html',
  './avx-probe.js',
];

// Pre-cache the shell on install.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Drop caches from previous versions, then take control of open pages.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key !== CACHE).map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Network-first: always try the network, refresh the cache, and fall back to
// the cache only when the network is unavailable (e.g. offline).
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  event.respondWith(
    fetch(request).then(response => {
      // Only cache successful, same-origin, basic responses.
      if (response.ok && response.type === 'basic') {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(request, copy));
      }
      return response;
    }).catch(() => caches.match(request))
  );
});

// Run the probe inside the service worker scope and reply on the given port.
// A user-agent spoof applied only to window.navigator does not reach this scope.
self.addEventListener('message', event => {
  if (event.data !== 'probe' || !event.ports[0]) return;
  const port = event.ports[0];
  event.waitUntil(
    cpuProbe().then(
      result => port.postMessage(result),
      err => port.postMessage({ scope: 'service worker', error: String(err) })
    )
  );
});