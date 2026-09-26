/* Cartouche service worker: keeps the app shell for offline use.
   The build fills FILES with every file in dist/ and VERSION with a hash of them (see vite.config.ts).
   Box art is cached separately by the page (Cache Storage "cartouche-boxart-*"); the player's ROMs and saves live in IndexedDB.
   The bundled ROMs in roms/ (under 1 MB together) are ordinary built files, so they are kept here too. */
const VERSION = 'dev';
const FILES = [/*__FILES__*/];
const CACHE = `cartouche-shell-${VERSION}`;
const INDEX = new URL('index.html', self.registration.scope).href;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // cartshelf-shell-*: the shell cache from before the app was renamed.
      .then((keys) => Promise.all(keys.filter((k) => /^(cartouche|cartshelf)-shell-/.test(k) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // Pages: network first (always the newest app), the cached shell when offline. Every route is the SPA.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match(INDEX)));
    return;
  }
  // Built files have hashed names, so a cached copy is always right.
  // ignoreVary: module scripts and styles are requested in CORS mode, and the server may answer with Vary: Origin.
  e.respondWith(caches.match(req, { ignoreVary: true }).then((hit) => hit || fetch(req)));
});
