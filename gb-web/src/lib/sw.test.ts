// node --test: public/sw.js run in a sandbox with a fake Cache Storage and network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SCOPE = 'https://x.test/cartouche/';

/** Loads sw.js with this version's cache holding `cached` (url → body); the network answers with `net` or never. */
function worker(cached: Record<string, string>, net: ((url: string) => string) | null) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const fetched: string[] = [];
  const sandbox = {
    self: { registration: { scope: SCOPE }, addEventListener: (t: string, h: (e: unknown) => void) => { handlers[t] = h; } },
    location: new URL(SCOPE),
    URL,
    caches: { match: async (r: string | { url: string }) => cached[typeof r === 'string' ? r : r.url] },
    fetch: (r: { url: string }) => {
      fetched.push(r.url);
      return net ? Promise.resolve(net(r.url)) : new Promise(() => {}); // a stalled connection
    },
  };
  vm.runInNewContext(readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'), sandbox);
  const get = (url: string, mode = 'navigate') => {
    let res: Promise<string | undefined> | undefined;
    handlers.fetch({ request: { method: 'GET', url, mode }, respondWith: (p: Promise<string | undefined>) => { res = p; } });
    return { res, fetched };
  };
  return get;
}

test('a page comes from the cached shell, never from a stalled network', { timeout: 2000 }, async () => {
  const get = worker({ [`${SCOPE}index.html`]: 'old shell' }, null);
  assert.equal(await get(`${SCOPE}settings/sync`).res, 'old shell');
  assert.equal(await get(SCOPE).res, 'old shell');
  assert.equal(await get(`${SCOPE}game/ucity/play`).res, 'old shell');
});

test('a page comes from the cached shell even when a newer one is online', { timeout: 2000 }, async () => {
  // A newer index.html would ask for chunks only the waiting version's cache has.
  const get = worker({ [`${SCOPE}index.html`]: 'old shell' }, () => 'new shell');
  const { res, fetched } = get(`${SCOPE}settings`);
  assert.equal(await res, 'old shell');
  assert.deepEqual(fetched, []);
});

test('the network serves pages until the shell is cached', { timeout: 2000 }, async () => {
  assert.equal(await worker({}, () => 'shell')(SCOPE).res, 'shell');
});

test('an opened file is the file, not the shell', { timeout: 2000 }, async () => {
  const get = worker({ [`${SCOPE}index.html`]: 'shell', [`${SCOPE}LICENSE.txt`]: 'license' }, (u) => `net ${u}`);
  assert.equal(await get(`${SCOPE}LICENSE.txt`).res, 'license');
  assert.equal(await get(`${SCOPE}roms/gbstudio/LICENSES.txt`).res, `net ${SCOPE}roms/gbstudio/LICENSES.txt`);
  assert.equal(await get(`${SCOPE}assets/x.js`, 'cors').res, `net ${SCOPE}assets/x.js`);
});

/** Posts 'activate' to sw.js while these window clients (urls) are open; true when the worker took over. */
async function activates(open: string[]) {
  const handlers: Record<string, (e: unknown) => void> = {};
  let skipped = false;
  const sandbox = {
    self: {
      registration: { scope: SCOPE },
      addEventListener: (t: string, h: (e: unknown) => void) => { handlers[t] = h; },
      clients: { matchAll: async () => open.map((url) => ({ url })) },
      skipWaiting: async () => { skipped = true; },
    },
    URL,
  };
  vm.runInNewContext(readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'), sandbox);
  let done: Promise<unknown> = Promise.resolve();
  handlers.message({ data: 'activate', waitUntil: (p: Promise<unknown>) => { done = p; } });
  await done;
  return skipped;
}

test('a waiting version takes over only a page that is alone', async () => {
  assert.equal(await activates([SCOPE]), true);
  // Another site on the same origin (other projects on the same Pages domain) doesn't count.
  assert.equal(await activates([`${SCOPE}settings`, 'https://x.test/other-app/']), true);
  // A second tab or window would lose its version's lazy chunks when the activate step prunes its cache.
  assert.equal(await activates([SCOPE, `${SCOPE}game/ucity`]), false);
});
