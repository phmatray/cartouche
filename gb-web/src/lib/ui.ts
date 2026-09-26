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

/** A byte count as KB, MB or GB (anything stored shows at least 1 KB). */
export const mb = (n: number) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(n ? 1 : 0, Math.round(n / 1024))} KB`);

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

/** "Developer · 1993" with missing parts dropped. */
export const byline = (g: GameEntry) => [g.developer, g.year].filter(Boolean).join(' · ');


/** Scroll behavior that respects prefers-reduced-motion. */
export const motion = (): ScrollBehavior => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
