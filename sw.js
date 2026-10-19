// Redio Life service worker: keeps the radio's own files available offline.
// Live streams and the station directory always go straight to the network.
const CACHE = 'starlite-v12';
const FILES = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './stations.js', './app.js'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Network first, and past the phone's 10-minute HTTP cache, so updates you upload show up straight away;
  // the cached copy is only for when you're offline.
  e.respondWith(
    fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }).then(r => {
      // If the site has moved, pass the redirect on: the browser refuses a followed redirect for a page load.
      if (r.redirected) return Response.redirect(r.url, 302);
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request))
  );
});
