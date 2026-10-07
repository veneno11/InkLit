// sw.js — offline caching (+ push handling, which stays idle until reminders are set up)
try {
  importScripts('https://www.gstatic.com/firebasejs/12.0.0/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/12.0.0/firebase-messaging-compat.js');
  firebase.initializeApp({
    apiKey: "AIzaSyAVnYiZFjoqoqT9kNbXdVr0CECIk1Lxz4Q",
    authDomain: "inklit-4b02e.firebaseapp.com",
    projectId: "inklit-4b02e",
    storageBucket: "inklit-4b02e.firebasestorage.app",
    messagingSenderId: "717603953139",
    appId: "1:717603953139:web:d3361f0fdb9da3f66b5a86"
  });
  firebase.messaging().onBackgroundMessage(payload => {
    if (payload.notification) return;
    const { title = "Inky's saved you a spot! 🦑", body = "Let's write today's sentence together!" } = payload.data || {};
    self.registration.showNotification(title, { body, icon: 'icon-192.png', badge: 'icon-192.png', data: { url: './#write' } });
  });
} catch (e) { /* push not available — offline caching still works */ }

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || './';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => 'focus' in c);
    return open ? open.focus() : clients.openWindow(url);
  }));
});

const CACHE = 'inklit-v1'; // change to inklit-v2, v3… whenever you upload new versions
const SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); return r; })
      .catch(() => caches.match('./index.html').then(r => r || caches.match('./'))));
    return;
  }
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
