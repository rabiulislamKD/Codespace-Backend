/* CodeSpace service worker.
   Caches ONLY the static app shell. Bridge/API calls (POST, /preview/stream, /term/stream,
   anything carrying an Authorization header) are never intercepted or cached. */
const VERSION = 'codespace-pwa-62-layout-refresh-3190';
const CACHE = 'my-chat-agent-' + VERSION;
const SHELL = ['/', '/manifest.webmanifest', '/css/01-base.css', '/css/02-steps.css', '/css/03-chat.css', '/css/04-editor.css', '/css/05-composer-plan.css', '/css/06-panels.css', '/css/07-extras.css', '/css/08-layout.css', '/js/app.js', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('my-chat-agent-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || req.headers.has('authorization')) return;
  if (/^\/(preview|term|vendor)\//.test(url.pathname)) return;           // live streams and terminal assets: always network
  if (req.mode === 'navigate') {                                          // network-first so updates arrive; cached shell when offline
    // Only the app root may refresh the cached shell — proxied Browser-panel pages (/browse?url=…)
    // must never overwrite it (3.13.5).
    e.respondWith(fetch(req).then(r => { if (url.pathname === '/' && r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put('/', copy)); } return r; }).catch(() => caches.match('/')));
    return;
  }
  if (SHELL.includes(url.pathname)) {                                     // static shell files: cache-first
    e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
  }
});
