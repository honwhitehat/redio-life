// Redio Life has moved to radio.cybergistplanet.com. This replaces the app's old service worker
// on honwhitehat.github.io: it clears the old cache, sends open windows on, and removes itself.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  await self.clients.claim();
  for (const k of await caches.keys()) await caches.delete(k);
  for (const c of await self.clients.matchAll({ type: 'window' })) {
    const u = new URL(c.url);
    c.navigate('https://radio.cybergistplanet.com' + u.pathname.replace(/^\/redio-life/, '') + u.search + u.hash).catch(() => {});
  }
  await self.registration.unregister();
})()));
