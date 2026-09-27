/* Cartouche service worker: keeps the app shell for offline use.
   The build fills FILES with every file in dist/ and VERSION with a hash of them (see vite.config.ts).
   Box art is cached separately by the page (Cache Storage "cartouche-boxart-*"); the player's ROMs and saves live in IndexedDB.
   The bundled ROMs in roms/ (under 1 MB together) are ordinary built files, so they are kept here too; not roms/gbstudio/
   (the GB Studio collection), which the page downloads into IndexedDB only when the player asks, through the network below.
   Updates: a new version installs in the background and waits. It never takes over a running page (whose lazy
   chunks would then be gone from the cache); the page asks it to take over on the next launch (see lib/pwa.ts),
   which it does only when no other tab or window of the app is open.
   Pages come from this version's cache first, so the page always matches the files this worker holds (a newer
   index.html from the network would ask for chunks only the waiting version has), and a launch on a stalled
   connection shows the app at once instead of waiting on the network. */
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
  // Only for a page that is alone: the activate step prunes the running version's cache, so any other open tab or
  // window would lose the lazy chunks it hasn't loaded yet. With several open, the update waits for a later launch.
  if (e.data === 'activate') {
    e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((all) => { if (all.filter((c) => c.url.startsWith(self.registration.scope)).length <= 1) return self.skipWaiting(); }));
  }
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
  // Pages: every route is the SPA, served from this version's cache (the network only before it's cached).
  // Opened files (a .txt license in a new tab) are not pages: they go the way of other files, below.
  if (req.mode === 'navigate' && !/\.(?!html$)[^/.]+$/.test(new URL(req.url).pathname)) {
    // no-store: never an HTTP-cached page from another version (Pages caches even its 404.html for 10 minutes).
    e.respondWith(caches.match(INDEX, { cacheName: CACHE }).then((hit) => hit || fetch(req, { cache: 'no-store' })));
    return;
  }
  // Built files have hashed names, so a cached copy is always right.
  // ignoreVary: module scripts and styles are requested in CORS mode, and the server may answer with Vary: Origin.
  e.respondWith(caches.match(req, { ignoreVary: true, cacheName: CACHE }).then((hit) => hit || fetch(req)));
});
