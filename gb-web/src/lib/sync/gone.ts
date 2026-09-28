/**
 * Deletions device sync passes on (tombstones, docs/SYNC.md): `sram:<save id>`, `state:<state id>` or `rom:<sha1>` →
 * when it was deleted. Written by db.ts's deletes (this device's ids: the sync turns them into shared keys), read by
 * the sync. Tiny and dependency-free: db.ts imports it.
 */
const GONE = 'cartouche.sync.gone';
export const loadGone = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(GONE) ?? '{}') as Record<string, number>; } catch { return {}; } };
export const saveGone = (g: Record<string, number>) => { try { localStorage.setItem(GONE, JSON.stringify(g)); } catch { /* storage full or blocked: the deletion won't sync */ } };
export function markGone(keys: string[], t = Date.now()) {
  if (!keys.length) return;
  const g = loadGone();
  for (const k of keys) g[k] = t;
  saveGone(g);
}
