// RetroAchievements, read-only: which of a game's achievements the player has earned, from RetroAchievements'
// public Web API (the only one of its APIs that answers a browser: it sends CORS headers; the emulator API does not).
// Nothing is unlocked here (see docs/RETROACHIEVEMENTS.md). Requests are made only once the player has entered
// their username and web API key, which stay in this browser's localStorage.

const API = 'https://retroachievements.org/API/';
export const BADGES = 'https://media.retroachievements.org/Badge/';
const CREDS = 'cartouche-ra';
const HASHES = 'cartouche-ra-hashes';
const WEEK = 7 * 864e5;
/** RetroAchievements' console ids: Game Boy, Game Boy Color. */
const CONSOLES = [4, 6];

export interface RaCreds { user: string; key: string }
export interface RaAchievement { id: number; title: string; description: string; points: number; badge: string; earned?: string; earnedHardcore?: string; order: number }
export interface RaGame { id: number; title: string; achievements: RaAchievement[] }

const store = () => { try { return localStorage; } catch { return null; } }; // blocked storage: signed out
export function getCreds(): RaCreds | null {
  try { const c = JSON.parse(store()?.getItem(CREDS) ?? 'null'); return c?.user && c?.key ? c : null; } catch { return null; }
}
export function setCreds(c: RaCreds | null) {
  if (c) store()?.setItem(CREDS, JSON.stringify(c)); else { store()?.removeItem(CREDS); store()?.removeItem(HASHES); }
}

/** The achievements list shows for a connected player's games whose ROM is in this browser (never downloads one). */
export const raShown = (g: { romUrl?: string; isLocal?: boolean; madeWith?: string }) => !!getCreds() && (g.isLocal || (!!g.romUrl && !g.madeWith));

/** Why a call failed: the key was refused, no such user (or game), or RetroAchievements could not be reached. */
export type RaFail = 'auth' | 'missing' | 'net';
export class RaError extends Error { kind: RaFail; constructor(kind: RaFail) { super(kind); this.kind = kind; } }

async function call<T>(endpoint: string, params: Record<string, string | number>, c: RaCreds): Promise<T> {
  const q = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), y: c.key });
  let r: Response;
  try { r = await fetch(`${API}${endpoint}.php?${q}`); } catch { throw new RaError('net'); }
  if (r.status === 401 || r.status === 403) throw new RaError('auth');
  if (r.status === 404) throw new RaError('missing');
  if (!r.ok) throw new RaError('net');
  return r.json();
}

/** Check a username and key (the profile answers only to a valid key); returns the username as RetroAchievements spells it. */
export async function checkCreds(c: RaCreds): Promise<string> {
  const p = await call<{ User?: string } | null>('API_GetUserProfile', { u: c.user }, c);
  if (!p?.User) throw new RaError('missing');
  return p.User;
}

/** The game's RetroAchievements id for this MD5, from the Game Boy and Color lists (kept a week), or null. */
export async function gameIdOf(md5: string, c: RaCreds): Promise<number | null> {
  let map: Record<string, number> | undefined;
  try { const m = JSON.parse(store()?.getItem(HASHES) ?? 'null'); if (m && Date.now() - m.at < WEEK) map = m.map; } catch { /* rebuilt below */ }
  if (!map) {
    // ponytail: the whole list (with hashes) of both consoles, a week at a time; a set added meanwhile shows next week.
    const lists = await Promise.all(CONSOLES.map((i) => call<{ ID: number; Hashes?: string[] }[]>('API_GetGameList', { i, h: 1, f: 1 }, c)));
    map = {};
    for (const g of lists.flat()) for (const h of g.Hashes ?? []) map[h.toLowerCase()] = g.ID;
    try { store()?.setItem(HASHES, JSON.stringify({ at: Date.now(), map })); } catch { /* full: fetched again next time */ }
  }
  return map[md5] ?? null;
}

interface ApiAchievement { ID: number; Title: string; Description: string; Points: number; BadgeName: string; DisplayOrder: number; DateEarned?: string; DateEarnedHardcore?: string }
/** The game's achievements and which ones the player has earned (softcore or hardcore). */
export async function progressOf(id: number, c: RaCreds): Promise<RaGame> {
  const g = await call<{ ID: number; Title: string; Achievements?: Record<string, ApiAchievement> }>('API_GetGameInfoAndUserProgress', { u: c.user, g: id }, c);
  const achievements = Object.values(g.Achievements ?? {}).map((a) => ({
    id: a.ID, title: a.Title, description: a.Description, points: a.Points, badge: a.BadgeName, order: a.DisplayOrder,
    earned: a.DateEarned, earnedHardcore: a.DateEarnedHardcore,
  })).sort((a, b) => a.order - b.order || a.id - b.id);
  return { id: g.ID, title: g.Title, achievements };
}

/** The ROM's MD5 off the main thread (up to ~0.1 s for 8 MB: a stutter while a game runs); inline if the worker fails. */
export function romHash(rom: Uint8Array): Promise<string> {
  return new Promise((done) => {
    const w = new Worker(new URL('../workers/md5-worker.ts', import.meta.url), { type: 'module' });
    const end = (h: string) => { w.terminate(); done(h); };
    w.onmessage = (e: MessageEvent<string>) => end(e.data);
    w.onerror = () => end(md5(rom));
    w.postMessage(rom);
  });
}

/** The ROM's RetroAchievements hash: for Game Boy and Color, the MD5 of the whole file (rcheevos rc_hash). */
export function md5(data: Uint8Array): string {
  const n = data.length, words = new Uint32Array((((n + 8) >> 6) + 1) * 16);
  for (let i = 0; i < n; i++) words[i >> 2] |= data[i] << ((i % 4) * 8);
  words[n >> 2] |= 0x80 << ((n % 4) * 8);
  words[words.length - 2] = n * 8;
  words[words.length - 1] = Math.floor(n / 0x20000000);
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let o = 0; o < words.length; o += 16) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      const r = i >> 4;
      const [f, g] = r === 0 ? [(b & c) | (~b & d), i] : r === 1 ? [(d & b) | (~d & c), (5 * i + 1) % 16]
        : r === 2 ? [b ^ c ^ d, (3 * i + 5) % 16] : [c ^ (b | ~d), (7 * i) % 16];
      const x = (a + f + K[i] + words[o + g]) >>> 0, s = S[r * 4 + (i % 4)];
      a = d; d = c; c = b;
      b = (b + ((x << s) | (x >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  return [a0, b0, c0, d0].map((v) => Array.from({ length: 4 }, (_, i) => ((v >>> (i * 8)) & 255).toString(16).padStart(2, '0')).join('')).join('');
}
