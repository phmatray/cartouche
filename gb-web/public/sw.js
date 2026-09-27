/* Cartouche service worker: keeps the app shell for offline use.
   The build fills FILES with every file in dist/ and VERSION with a hash of them (see vite.config.ts).
   Box art is cached separately by the page (Cache Storage "cartouche-boxart-*"); the player's ROMs and saves live in IndexedDB.
   The bundled ROMs in roms/ (under 1 MB together) are ordinary built files, so they are kept here too; not roms/gbstudio/
   (the GB Studio collection), which the page downloads into IndexedDB only when the player asks, through the network below.
   Updates: a new version installs in the background and waits. It never takes over a running page (whose lazy
   chunks would then be gone from the cache); the page asks it to take over on the next launch (see lib/pwa.ts). */
const VERSION = 'dev';
const FILES = [/*__FILES__*/];
const CACHE = `cartouche-shell-${VERSION}`;
const INDEX = new URL('index.html', self.registration.scope).href;

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the HTTP cache, so a new version never stores a stale copy of a file.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
});

// Drops the shell caches of other versions (cartshelf-shell-*: from before the app was renamed).
const prune = () => caches.keys()
  .then((keys) => Promise.all(keys.filter((k) => /^(cartouche|cartshelf)-shell-/.test(k) && k !== CACHE).map((k) => caches.delete(k))));

self.addEventListener('message', (e) => {
  if (e.data === 'activate') self.skipWaiting();
  // The page asks which version runs it (for the "Updated" toast). Prune again here, while no newer version is on
  // its way: WebKit can skip the activate cleanup when it activates a waiting worker on its own at relaunch.
  if (e.data === 'version') {
    e.source?.postMessage({ version: VERSION });
    if (!self.registration.installing && !self.registration.waiting) e.waitUntil(prune());
  }
});

self.addEventListener('activate', (e) => { e.waitUntil(prune().then(() => self.clients.claim())); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // Other sites (box art from GitHub) are never touched here: the page keeps those in its own cache.
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // Pages: network first (always the newest app), the cached shell when offline. Every route is the SPA.
  if (req.mode === 'navigate') {
    // no-store: never an HTTP-cached page from another version (Pages caches even its 404.html for 10 minutes).
    e.respondWith(fetch(req, { cache: 'no-store' }).catch(() => caches.match(INDEX, { cacheName: CACHE })));
    return;
  }
  // Built files have hashed names, so a cached copy is always right.
  // ignoreVary: module scripts and styles are requested in CORS mode, and the server may answer with Vary: Origin.
  e.respondWith(caches.match(req, { ignoreVary: true, cacheName: CACHE }).then((hit) => hit || fetch(req)));
});
