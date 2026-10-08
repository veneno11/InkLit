/* InkLit V2.1 service worker
   - New cache names flush older caches on activate.
   - App shell works fully offline; the Firebase SDK and fonts are cached after first load,
     so Firestore's offline cache can boot without a connection and re-sync on reconnect.
   - Firestore, Auth, Gemini and avatar requests always go straight to the network.
   - V2.1: live reading-timer notification while InkLit is minimized or closed. */

const VERSION = 'v2.1';
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
  const d = event.data || {};
  if (d.type === 'SKIP_WAITING') self.skipWaiting();
  else if (d.type === 'TIMER_SHOW') event.waitUntil(showTimer(d));
  else if (d.type === 'TIMER_HIDE') event.waitUntil(hideTimer());
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

/* Live reading-timer notification.
   The page sends TIMER_SHOW when it's hidden with a session running. This worker redraws
   the notification every few seconds for as long as the browser keeps it awake (about
   5 minutes per wake-up; the page re-arms it while it's alive). The page's timer is
   timestamp-based, so the time is exact whenever the app is reopened. */
const TIMER_TAG = 'inklit-timer';
const TIMER_TICK_MS = 5000;
const TIMER_WAKE_MS = 4.5 * 60 * 1000;
let timerState = null;  // { base, mode, targetMs, book, endsAt }
let timerLoop = null;
let timerWake = null;
let dismissedBase = 0;  // a session the reader swiped away; don't bring it back

const pad2 = n => String(n).padStart(2, '0');
function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
}

async function drawTimer() {
  const t = timerState;
  if (!t) return;
  const elapsed = Date.now() - t.base;
  const countdown = t.mode === 'countdown';
  if (countdown && elapsed >= t.targetMs) {
    timerState = null;
    await self.registration.showNotification('📚 Reading session complete', {
      tag: TIMER_TAG, renotify: true, requireInteraction: true, vibrate: [200, 100, 200],
      body: `You read for ${Math.round(t.targetMs / 60000)} minutes. Tap to log your pages.`,
      icon: 'icon-192.png', badge: 'icon-192.png', data: { tab: 'home', action: 'timer', kind: 'done' }
    });
    return;
  }
  await self.registration.showNotification(countdown ? `Reading · ${clock(t.targetMs - elapsed)} left` : `Reading · ${clock(elapsed)}`, {
    tag: TIMER_TAG, silent: true, renotify: false, requireInteraction: true, timestamp: t.base,
    body: [t.book, countdown && t.endsAt ? `Ends at ${t.endsAt}` : '', 'Tap to open your timer'].filter(Boolean).join(' · '),
    icon: 'icon-192.png', badge: 'icon-192.png', data: { tab: 'home', action: 'timer', kind: 'live', base: t.base }
  });
}

function runTimerLoop() {
  if (timerLoop) return timerLoop;
  timerLoop = (async () => {
    const until = Date.now() + TIMER_WAKE_MS;
    while (timerState && Date.now() < until) {
      try { await drawTimer(); } catch { timerState = null; } // no permission: stop quietly
      if (!timerState) break;
      await new Promise(r => { timerWake = r; setTimeout(r, TIMER_TICK_MS); });
    }
  })().finally(() => { timerLoop = null; timerWake = null; });
  return timerLoop;
}

function showTimer(d) {
  if (!d.base || d.base === dismissedBase) return Promise.resolve();
  timerState = { base: d.base, mode: d.mode, targetMs: d.targetMs, book: d.book || '', endsAt: d.endsAt || '' };
  return runTimerLoop();
}

async function hideTimer() {
  timerState = null;
  if (timerWake) timerWake();
  if (timerLoop) await timerLoop;
  const list = await self.registration.getNotifications({ tag: TIMER_TAG });
  list.forEach(n => { if (n.data && n.data.kind === 'live') n.close(); });
}

self.addEventListener('notificationclose', event => {
  const data = event.notification.data || {};
  if (data.kind !== 'live') return;
  dismissedBase = data.base || 0;
  timerState = null;
  if (timerWake) timerWake();
});

/* Friend cheers, timer alerts and the live timer all open the app here. */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const tab = data.tab || 'home';
  const openTimer = data.action === 'timer';
  if (data.kind === 'live') { timerState = null; if (timerWake) timerWake(); }
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of list) {
      if ('focus' in client) {
        await client.focus();
        client.postMessage(openTimer ? { type: 'OPEN_TIMER' } : { type: 'OPEN_TAB', tab });
        return;
      }
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(new URL(openTimer ? './?action=timer' : `./#${tab}`, self.registration.scope).href);
    }
  })());
});
