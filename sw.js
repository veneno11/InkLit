/* InkLit V2 service worker
   - New cache names flush every V1 cache (inklit-v1) on activate.
   - App shell works fully offline; the Firebase SDK and fonts are cached after first load,
     so Firestore's offline cache can boot without a connection and re-sync on reconnect.
   - Firestore, Auth, Gemini and avatar requests always go straight to the network. */

const VERSION = 'v2';
const APP_CACHE = `inklit-${VERSION}-app-cache`;
const RUNTIME_CACHE = `inklit-${VERSION}-runtime-cache`;
const KEEP = [APP_CACHE, RUNTIME_CACHE];
const SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './icon-maskable-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(APP_CACHE).then(cache =>
      Promise.allSettled(SHELL.map(url => cache.add(new Request(url, { cache: 'reload' }))))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => !KEEP.includes(key)).map(key => caches.delete(key)));
    await self.clients.claim();
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    windows.forEach(client => client.postMessage({ type: 'SW_ACTIVATED', version: VERSION }));
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

const isFirebaseSdk = url => url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/');
const isAppPage = url => url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') event.respondWith(networkFirstPage(req, url));
    else event.respondWith(staleWhileRevalidate(event, req, APP_CACHE));
    return;
  }
  if (isFirebaseSdk(url) || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(cacheFirst(req));
    return;
  }
  if (url.hostname === 'fonts.googleapis.com') {
    event.respondWith(staleWhileRevalidate(event, req, RUNTIME_CACHE));
  }
  // Everything else (Firestore, Auth, Gemini, profile photos) is network-only.
});

async function networkFirstPage(req, url) {
  const cache = await caches.open(APP_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && isAppPage(url)) cache.put('./index.html', res.clone());
    return res;
  } catch {
    return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
  }
}

async function staleWhileRevalidate(event, req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const network = fetch(req)
    .then(res => { if (res.ok) cache.put(req, res.clone()); return res; })
    .catch(() => hit || Response.error());
  if (hit) { event.waitUntil(network); return hit; }
  return network;
}

async function cacheFirst(req) {
  const cache = await caches.open(RUNTIME_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
    return res;
  } catch {
    return Response.error();
  }
}

/* Background Sync: the page registers this tag when it goes offline.
   On reconnect, open windows are told to flush pending cloud writes. */
self.addEventListener('sync', event => {
  if (event.tag !== 'inklit-resync') return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(list => list.forEach(c => c.postMessage({ type: 'RESYNC' })))
  );
});

/* Friend cheers and timer alerts are shown by the page through registration.showNotification. */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const tab = (event.notification.data && event.notification.data.tab) || 'home';
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of list) {
      if ('focus' in client) {
        await client.focus();
        client.postMessage({ type: 'OPEN_TAB', tab });
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(new URL(`./#${tab}`, self.registration.scope).href);
  })());
});
