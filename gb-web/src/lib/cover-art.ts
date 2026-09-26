import { create } from 'zustand';
import { useSettingsStore } from '../store/settingsStore';

/**
 * Box art lives in libretro-thumbnails, one repository per platform. The file name is known ahead
 * of time (the No-Intro name stored with each GameDB entry), so no repository listing is ever
 * requested: games without a known name keep their printed card and make no request at all.
 */
const REPOS = { gb: 'Nintendo_-_Game_Boy', gbc: 'Nintendo_-_Game_Boy_Color' } as const;
const rawBase = (platform: keyof typeof REPOS) => `https://raw.githubusercontent.com/libretro-thumbnails/${REPOS[platform]}/master/Named_Boxarts`;
/** Box art is downloaded once, then served from Cache Storage (bump the name to invalidate). */
const CACHE_NAME = 'cartouche-boxart-v1';
/** The cache's name before the app was renamed: its box art moves over once, then it is deleted. */
const OLD_CACHE_NAME = 'cartshelf-boxart-v1';
async function migrateOldCache() {
  try {
    if (!(await caches.has(OLD_CACHE_NAME))) return;
    const [old, cur] = await Promise.all([caches.open(OLD_CACHE_NAME), caches.open(CACHE_NAME)]);
    for (const req of await old.keys()) { const res = await old.match(req); if (res) await cur.put(req, res); }
    await caches.delete(OLD_CACHE_NAME);
  } catch { /* Cache Storage unavailable */ }
}
const migrated = typeof caches === 'undefined' ? Promise.resolve() : migrateOldCache();

// In-memory caches: resolved object URLs and in-flight lookups
const coverCache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();
/** Bumped by deleteBoxArt(): a download still in flight then keeps nothing. */
let generation = 0;

async function cachedFetch(url: string): Promise<Response | null> {
  let cache: Cache | null = null;
  await migrated;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) return hit;
  } catch { /* Cache Storage unavailable (insecure context, private mode): fall through to the network */ }
  const gen = generation;
  const res = await fetch(url, { cache: 'no-store' }); // Cache Storage is the only copy: Delete removes it all
  if (!res.ok) return null;
  if (gen === generation) await cache?.put(url, res.clone()).catch(() => {});
  return res;
}

async function isPng(blob: Blob): Promise<boolean> {
  const b = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

/**
 * libretro-thumbnails stores many variants as git symlinks. Served raw, a symlink's body is the
 * target file name as plain text (e.g. "Dr. Mario (World).png"), not a PNG: follow it.
 */
async function fetchBoxart(base: string, filename: string, hops = 0): Promise<Blob | null> {
  const res = await cachedFetch(`${base}/${encodeURIComponent(filename)}`);
  if (!res) return null;
  const blob = await res.blob();
  if (await isPng(blob)) return blob.type === 'image/png' ? blob : new Blob([blob], { type: 'image/png' });
  if (hops >= 3 || blob.size > 1024) return null;
  const target = (await blob.text()).trim().split('/').pop();
  return target ? fetchBoxart(base, target, hops + 1) : null;
}

export type Platform = keyof typeof REPOS;
const cacheKeyOf = (libretroName: string, platform: Platform = 'gb') => `${platform}/${libretroName}`;

/** Synchronous peek: an object URL, null (no art), or undefined (not resolved yet). */
export function peekCoverArt(libretroName?: string, platform?: Platform): string | null | undefined {
  return libretroName ? coverCache.get(cacheKeyOf(libretroName, platform)) : null;
}

/** The one gate for every box-art request: the setting is on AND the player said yes in the dialog. */
export const boxArtAllowed = (s: { showBoxArt: boolean; boxArtAnswer: { consent: boolean } | null }) => s.showBoxArt && !!s.boxArtAnswer?.consent;

export function getCoverArtUrl(libretroName?: string, platform: Platform = 'gb'): Promise<string | null> {
  // Box art is not allowed, or the game has no known box-art name: never contact libretro-thumbnails.
  if (!libretroName || !boxArtAllowed(useSettingsStore.getState())) return Promise.resolve(null);
  const key = cacheKeyOf(libretroName, platform);
  if (coverCache.has(key)) return Promise.resolve(coverCache.get(key)!);
  let p = inflight.get(key);
  if (!p) {
    const gen = generation;
    p = (async () => {
      try {
        const blob = await fetchBoxart(rawBase(platform), `${libretroName}.png`);
        const url = blob ? URL.createObjectURL(blob) : null;
        if (gen === generation) coverCache.set(key, url);
        return url;
      } catch {
        return null; // network error: not cached, retried next time
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
  }
  return p;
}

/** "Fetching box art · n of m" while a whole library is being downloaded (of = 0: idle). */
export const useBoxArtProgress = create<{ n: number; of: number }>(() => ({ n: 0, of: 0 }));

type ArtGame = { libretroName?: string; platform?: Platform; coverArt?: string };
/** A game whose cover would come from libretro-thumbnails: recognized, and without a bundled cover of its own. */
export const needsDownload = (g: ArtGame) => !!g.libretroName && !g.coverArt;
/** Said (toast and Settings › Storage) when a download finds nothing to fetch. */
export const NO_COVERS = 'No covers to fetch yet. Covers appear for recognized games you add; bundled games use their own art.';

/**
 * Download the box art of every recognized game now (it lands in Cache Storage; covers fade in).
 * Resolves to the number of games that can have downloaded box art (0: nothing to fetch).
 */
export async function fetchBoxArtFor(games: ArtGame[]): Promise<number> {
  const eligible = games.filter(needsDownload);
  const todo = eligible.filter((g) => peekCoverArt(g.libretroName, g.platform) === undefined);
  if (!todo.length || useBoxArtProgress.getState().of) return eligible.length;
  useBoxArtProgress.setState({ n: 0, of: todo.length });
  const gen = generation;
  let n = 0;
  // ponytail: 4 at a time, enough for a GitHub raw host without flooding it
  const worker = async () => {
    for (let g; (g = todo.shift()) && gen === generation;) {
      await getCoverArtUrl(g.libretroName, g.platform);
      useBoxArtProgress.setState({ n: ++n });
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  useBoxArtProgress.setState({ n: 0, of: 0 });
  return eligible.length;
}

/** Forget one game's downloaded cover (memory and Cache Storage), e.g. when the game is removed. */
export async function forgetBoxArt(g: ArtGame) {
  if (!needsDownload(g)) return;
  const key = cacheKeyOf(g.libretroName!, g.platform);
  const url = coverCache.get(key);
  if (url) URL.revokeObjectURL(url);
  coverCache.delete(key);
  try { await (await caches.open(CACHE_NAME)).delete(`${rawBase(g.platform ?? 'gb')}/${encodeURIComponent(`${g.libretroName}.png`)}`); } catch { /* Cache Storage unavailable */ }
}

/** Bytes of downloaded box art kept for one game (0: none), read from Cache Storage only: never a request. */
async function cachedArtBytes(cache: Cache, base: string, filename: string, hops = 0): Promise<number> {
  const res = await cache.match(`${base}/${encodeURIComponent(filename)}`);
  if (!res) return 0;
  const blob = await res.blob();
  if (await isPng(blob)) return blob.size;
  if (hops >= 3 || blob.size > 1024) return 0;
  const target = (await blob.text()).trim().split('/').pop(); // a libretro symlink: follow it, as fetchBoxart does
  return target ? cachedArtBytes(cache, base, target, hops + 1) : 0;
}

/** Downloaded box art per game id (bytes), for the games given. */
export async function boxArtPerGame(games: (ArtGame & { id: string })[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    await migrated;
    if (!(await caches.has(CACHE_NAME))) return out;
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(games.filter(needsDownload).map(async (g) => {
      const n = await cachedArtBytes(cache, rawBase(g.platform ?? 'gb'), `${g.libretroName}.png`);
      if (n) out.set(g.id, n);
    }));
  } catch { /* Cache Storage unavailable */ }
  return out;
}

/** Bytes of box art kept in Cache Storage. */
export async function boxArtBytes(): Promise<number> {
  try {
    await migrated;
    if (!(await caches.has(CACHE_NAME))) return 0;
    const cache = await caches.open(CACHE_NAME);
    let total = 0;
    for (const req of await cache.keys()) total += (await (await cache.match(req))?.blob())?.size ?? 0;
    return total;
  } catch { return 0; }
}

/** Forget every downloaded cover (memory and Cache Storage) and turn box art off. */
export async function deleteBoxArt() {
  generation++;
  useSettingsStore.getState().setShowBoxArt(false);
  useBoxArtProgress.setState({ n: 0, of: 0 });
  for (const url of coverCache.values()) if (url) URL.revokeObjectURL(url);
  coverCache.clear();
  inflight.clear();
  await migrated;
  try { await caches.delete(CACHE_NAME); } catch { /* Cache Storage unavailable */ }
}

/** The "Show box art?" dialog: open on first launch until answered, or when the player asks again. */
export const useBoxArtPrompt = create<{ open: boolean }>(() => ({ open: false }));
export const askBoxArt = () => useBoxArtPrompt.setState({ open: true });
/** Record the player's answer (a yes also turns box art on). */
export function answerBoxArt(consent: boolean) {
  useSettingsStore.getState().set({ boxArtAnswer: { consent, at: Date.now() }, ...(consent && { showBoxArt: true }) });
  useBoxArtPrompt.setState({ open: false });
}

const inkCache = new Map<string, string | null>();
/** The ink of a cover already sampled (a page opened from its box starts in the right colour). */
export const cachedInk = (url: string) => inkCache.get(url) ?? null;

/**
 * The game's "flood" ink: the dominant saturated hue of its box art, laid down at a fixed
 * depth (like #84641F) so white text always reads on it. Null when the art has no strong color.
 */
export async function sampleInk(url: string): Promise<string | null> {
  if (inkCache.has(url)) return inkCache.get(url)!;
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, 32, 32);
  const d = ctx.getImageData(0, 0, 32, 32).data;
  const BINS = 24;
  const weight = new Float64Array(BINS);
  const hueSum = new Float64Array(BINS);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, delta = max - min;
    if (d[i + 3] < 128 || delta === 0) continue;
    const s = delta / (1 - Math.abs(2 * l - 1));
    if (s < 0.35 || l < 0.12 || l > 0.88) continue;
    let h = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    h = (h * 60 + 360) % 360;
    const bin = Math.floor((h / 360) * BINS) % BINS;
    weight[bin] += s;
    hueSum[bin] += h * s;
  }
  let best = -1;
  for (let i = 0; i < BINS; i++) if (weight[i] > (best < 0 ? 0 : weight[best])) best = i;
  // Needs a meaningful share of the cover (not a few stray pixels) to count as its ink.
  const ink = best >= 0 && weight[best] > 20 ? `hsl(${Math.round(hueSum[best] / weight[best])} 62% 32%)` : null;
  inkCache.set(url, ink);
  return ink;
}

/** Deterministic fallback ink when a game has no box art (or none with color). */
export function fallbackInk(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 62% 32%)`;
}
