import type { GameEntry } from '../types/game';

/** Route builders: /game/:id is the game page, /game/:id/play the player. */
export const paths = {
  play: (id: string, q = '') => `/game/${encodeURIComponent(id)}/play${q}`,
  game: (id: string) => `/game/${encodeURIComponent(id)}`,
};

/** Resolve a public asset / ROM URL against Vite's BASE_URL (the app is served from /cartouche/). Absolute URLs pass through. */
export function assetUrl(url: string): string {
  return new URL(url.replace(/^\//, ''), new URL(import.meta.env.BASE_URL, location.origin)).href;
}

export function ago(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} hour${h > 1 ? 's' : ''} ago`;
  const d = Math.round(h / 24); if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  const w = Math.round(d / 7); if (d < 30) return `${w} week${w > 1 ? 's' : ''} ago`;
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
}

export function dur(seconds?: number): string {
  if (!seconds) return '—';
  if (seconds < 60) return '< 1 m';
  const h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} m`;
}

/** A KeyboardEvent.key as printed on a key cap. */
export function keyLabel(k: string): string {
  if (!k) return '—';
  const named: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ' ': 'Space', Control: 'Ctrl', Escape: 'Esc' };
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
  if (!owned(g)) return ['need', 'Needs your ROM'];
  if (g.isLocal && saved.has(g.id)) return ['saved', 'Saved'];
  if (playsNow(g)) return ['now', 'Play now'];
  return ['rom', 'Your ROM'];
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

/** Relevance of a game for a query (from `searchKey`); 0 = no match. Every word must appear in the title or the details. */
export function score(g: GameEntry, q: string): number {
  const words = q.split(' ').filter(Boolean);
  const t = folded(g.title).s;
  const rest = folded(`${g.developer ?? ''} ${g.year ?? ''} ${g.platform ? `${PLATFORM[g.platform]} ${g.platform}` : ''} ${g.region ?? ''} ${g.genre}`).s;
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


/** "32 KB", "512 bytes". */
export const bytes = (n: number) => (n >= 1024 ? `${Math.round(n / 102.4) / 10} KB` : `${n} bytes`);

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
