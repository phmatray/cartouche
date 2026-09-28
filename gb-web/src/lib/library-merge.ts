import type { GameEntry } from '../types/game';
import { titleKey } from './rom-utils.ts';

// A library load matches every user ROM against the whole catalog: each catalog title is folded once, not once per ROM.
const catKeys = new WeakMap<GameEntry, string>();
function catKey(g: GameEntry) {
  let k = catKeys.get(g);
  if (k === undefined) catKeys.set(g, (k = titleKey(g.title)));
  return k;
}

/**
 * The catalog entry a user ROM belongs to: same id, same SHA-1 (hosted GB Studio games), same title, or else an
 * unknown dump whose header title starts one catalog title and no other (GB Studio headers: 'OPOSSUMCOUNTR').
 */
export function catalogMatch(list: GameEntry[], e: GameEntry) {
  const k = titleKey(e.title);
  const found = list.find((g) => !g.isLocal && (g.id === e.id || (!!e.sha1 && g.sha1 === e.sha1) || catKey(g) === k));
  const h = titleKey(e.romHeaderTitle ?? '');
  if (found || e.developer || h.length < 6) return found;
  const hits = list.filter((g) => !g.isLocal && catKey(g).startsWith(h));
  return hits.length === 1 ? hits[0] : undefined;
}

/** A user ROM dressed with the catalog entry it matched: it keeps the catalog's details. */
function merged(cat: GameEntry | undefined, e: GameEntry): GameEntry {
  return cat ? {
    ...cat, ...e,
    title: e.developer ? e.title : cat.title, // no GameDB match: the catalog title beats a file name
    description: e.developer ? e.description : cat.description || e.description,
    descriptions: e.developer ? undefined : cat.descriptions,
    regions: e.regions?.length ? e.regions : cat.regions,
    genre: e.genre !== 'Unknown' ? e.genre : cat.genre,
    developer: e.developer ?? cat.developer,
    year: e.year ?? cat.year,
    romUrl: cat.romUrl,
    coverArt: cat.coverArt || e.coverArt,
    coverCredit: cat.coverCredit,
  } : e;
}

/**
 * Put a user ROM on the shelf. When it matches a catalog entry (same id, or same title) it replaces
 * that entry instead of appearing twice, and keeps the catalog's details.
 */
export function withLocal(list: GameEntry[], e: GameEntry): GameEntry[] {
  const cat = catalogMatch(list, e);
  return [...list.filter((g) => g !== cat && g.id !== e.id), merged(cat, e)];
}

/**
 * `add.reduce(withLocal, list)`, in one pass: each ROM is matched against the catalog entries still unmatched, not the
 * whole shelf copied again per ROM (5,000 ROMs took over half a second of a library load).
 */
export function withLocals(list: GameEntry[], add: GameEntry[]): GameEntry[] {
  if (add.length < 2) return add.reduce(withLocal, list);
  let pool = list.filter((g) => !g.isLocal); // what catalogMatch can pick: the catalog entries not replaced yet
  const byId = new Map<string, GameEntry>(); // insertion order = shelf order; a replaced id moves to the end
  for (const g of list) byId.set(g.id, g);
  for (const e of add) {
    const cat = catalogMatch(pool, e);
    if (cat) {
      pool = pool.filter((g) => g !== cat);
      if (byId.get(cat.id) === cat) byId.delete(cat.id);
    }
    const old = byId.get(e.id);
    if (old && !old.isLocal) pool = pool.filter((g) => g !== old);
    byId.delete(e.id);
    byId.set(e.id, merged(cat, e));
  }
  return [...byId.values()];
}

/** The shelf with more catalog entries: the user ROMs already on it are matched against them again. */
export function withCatalog(shelf: GameEntry[], more: GameEntry[]): GameEntry[] {
  return withLocals([...shelf.filter((g) => !g.isLocal), ...more], shelf.filter((g) => g.isLocal));
}
