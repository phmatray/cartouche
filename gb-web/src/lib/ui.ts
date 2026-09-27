import type { KeyboardEvent } from 'react';
import type { GameEntry } from '../types/game';
import { size, t } from '../i18n/core.ts';

/** Route builders: /game/:id is the game page, /game/:id/play the player. */
export const paths = {
  play: (id: string, q = '') => `/game/${encodeURIComponent(id)}/play${q}`,
  game: (id: string) => `/game/${encodeURIComponent(id)}`,
  /** The search overlay over the library, with a query in the search syntax (readable: `?q=genre:rpg+players:2`). */
  search: (q: string) => `/?q=${encodeURIComponent(q).replace(/%20/g, '+').replace(/%3A/gi, ':').replace(/%2C/gi, ',')}`,
};
/**
 * History state for a link that opens the search: the entry it was opened from (React Router's `idx`), so
 * closing steps back to it however many searches were pushed since. Read when the link renders.
 */
export const searchState = () => ({ from: (history.state as { idx?: number } | null)?.idx ?? 0 });

/** The focusable in `pool` nearest to `from` in an arrow key's direction (TV-style spatial navigation), or null. */
export function spatialNext(from: Element, key: string, pool: Iterable<HTMLElement>): HTMLElement | null {
  const d = ({ ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] } as Record<string, number[]>)[key];
  if (!d) return null;
  const a = from.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best: HTMLElement | null = null, bestDist = Infinity;
  for (const el of pool) {
    const r = el.getBoundingClientRect();
    if (el === from || !r.width) continue;
    const dx = r.left + r.width / 2 - ax, dy = r.top + r.height / 2 - ay;
    const along = dx * d[0] + dy * d[1], across = Math.abs(d[0] ? dy : dx);
    const reach = d[0] ? (a.width + r.width) / 2 : (a.height + r.height) / 2;
    if (along < reach / 2) continue; // not past the current element in that direction
    const dist = along + across * 3;
    if (dist < bestDist) { bestDist = dist; best = el; }
  }
  return best;
}

/** Resolve a public asset / ROM URL against Vite's BASE_URL (the app is served from /cartouche/). Absolute URLs pass through. */
export function assetUrl(url: string): string {
  return new URL(url.replace(/^\//, ''), new URL(import.meta.env.BASE_URL, location.origin)).href;
}

// Relative times, sizes and play time follow the active language (see i18n/core).
export { ago, dur } from '../i18n/core.ts';
/** A byte count as bytes, kB, MB or GB. */
export const mb = size;

/** A KeyboardEvent.key as printed on a key cap. */
export function keyLabel(k: string): string {
  if (!k) return '—';
  const named: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ' ': t('common.keys.space'), Control: 'Ctrl', Escape: 'Esc' };
  return named[k] ?? (k.length === 1 ? k.toUpperCase() : k);
}

export const sortTitle =(t: string) => t.replace(/^The /i, '');
export function letterOf(g: GameEntry): string {
  const c = sortTitle(g.title).charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : '#';
}

/** Catalog category of the bundled test ROMs (acid2, cpu_instrs): a shelf of their own. */
export const TEST_CATEGORY = 'Test cartridges';

/** Can be played without the user's own file (bundled / free homebrew). */
export const playsNow = (g: GameEntry) => !g.isLocal && !!g.romUrl;
export const owned = (g: GameEntry) => g.isLocal || !!g.romUrl;

export type TagKind = 'need' | 'saved' | 'now' | 'rom';
export function tagOf(g: GameEntry, saved: Set<string>): [TagKind, string] {
  if (!owned(g)) return ['need', t(g.madeWith ? 'common.tag.author' : 'common.tag.need')];
  if (g.isLocal && saved.has(g.id)) return ['saved', t('common.tag.saved')];
  if (playsNow(g)) return ['now', t('common.tag.now')];
  return ['rom', t('common.tag.rom')];
}

/**
 * The searchable form of `s`: lower-case, accents gone ("é" → "e"), apostrophes gone ("Link's" → "links"),
 * other punctuation turned into single spaces. `at[k]` is the index in `s` of the k-th kept character,
 * so a match can be marked back in the original text.
 */
export function folded(s: string): { s: string; at: number[] } {
  let out = '';
  const at: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i].normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().charAt(0);
    if (!c || /['’‘`]/.test(c)) continue;
    const ch = /[\p{L}\p{N}]/u.test(c) ? c : ' ';
    if (ch === ' ' && (!out || out.endsWith(' '))) continue;
    out += ch; at.push(i);
  }
  if (out.endsWith(' ')) { out = out.slice(0, -1); at.pop(); }
  return { s: out, at };
}
/** A search query in the form `score` and `Hl` expect. */
export const searchKey = (query: string) => folded(query).s;

/** The folded title and details `score` searches (computed once per game by the search index). */
export const searchFields = (g: GameEntry) => ({
  t: folded(g.title).s,
  rest: folded(`${g.developer ?? ''} ${g.publisher ?? ''} ${g.year ?? ''} ${g.platform ? `${PLATFORM[g.platform]} ${g.platform}` : ''} ${g.region ?? ''} ${g.genre}`).s,
});

/** Relevance of a game for a query (from `searchKey`); 0 = no match. Every word must appear in the title or the details. */
export function score(g: GameEntry, q: string, { t, rest } = searchFields(g)): number {
  const words = q.split(' ').filter(Boolean);
  if (!words.length || !words.every((w) => t.includes(w) || rest.includes(w))) return 0;
  const s = t === q ? 100 : t.startsWith(q) ? 80 : ` ${t}`.includes(` ${q}`) ? 60 : t.includes(q) ? 40
    : words.every((w) => t.includes(w)) ? 30 : words.some((w) => t.includes(w)) ? 20 : 10;
  return s + (owned(g) ? 5 : 0);
}

/** Two players per the GameDB. Unknown (catalog homebrew, unrecognized dumps) is not guessed. */
export const linkReady = (g: GameEntry) => (g.players ?? 0) >= 2;
export const PLATFORM = { gb: 'Game Boy', gbc: 'Game Boy Color' } as const;

/** "Developer · 1993" with missing parts dropped. */
export const byline = (g: GameEntry) => [g.developer, g.year].filter(Boolean).join(' · ');


/** "32 kB", "512 bytes". */
export const bytes = size;

/** Save a Blob as a file. */
export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Scroll behavior that respects prefers-reduced-motion. */
export const motion = (): ScrollBehavior => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

/** onKeyDown for a modal <dialog>: keep Tab inside it (it otherwise lets focus leave for the page body or the browser's own UI). */
export function trapTab(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== 'Tab') return;
  const f = [...e.currentTarget.querySelectorAll<HTMLElement>('a[href],button:not([disabled])')];
  if (!f.length) return;
  const edge = e.shiftKey ? f[0] : f[f.length - 1];
  if (document.activeElement === edge) { e.preventDefault(); (e.shiftKey ? f[f.length - 1] : f[0]).focus(); }
}
