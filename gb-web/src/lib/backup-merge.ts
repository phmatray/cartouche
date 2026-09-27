/**
 * Restoring a backup next to another library: ROMs are matched by SHA-1, never by id (two different games can share
 * one: file names that aren't Latin all become 'rom', 'rom-2'… in import order). What the backup saved for a game
 * follows that game to the id it gets here.
 */

/**
 * Where a backup ROM goes: onto the same dump already here (`store: false`), its own id first, else under its own id,
 * or the first free `id-2`, `id-3`… when that id holds a different game. A dump stored twice on purpose (a second
 * copy, for separate saves) stays two: each local copy takes one backup copy. `here`: id → SHA-1 of the ROMs here,
 * updated; `claimed`: the ids a backup ROM already went to.
 */
export function placeRom(id: string, sha1: string, here: Map<string, string>, claimed: Set<string>): { id: string; store: boolean } {
  const same = here.get(id) === sha1 && !claimed.has(id) ? id : [...here].find(([i, h]) => h === sha1 && !claimed.has(i))?.[0];
  let to = same ?? id;
  if (same === undefined) for (let n = 2; here.has(to); n++) to = `${id}-${n}`;
  here.set(to, sha1);
  claimed.add(to);
  return { id: to, store: same === undefined };
}

const STATE_SUFFIX = /-(slot-\d+|auto)$/;

/** The backup's records with each game id moved as `moved` says (backup id → id here). */
export function mover(moved: Map<string, string>) {
  const game = (g: string) => moved.get(g) ?? g;
  // A save profile id is the game id, or `${gameId}~suffix`; a save state's is `${gameId}-slot-N` or `${gameId}-auto`.
  const save = (id: string) => { const g = id.split('~')[0]; return game(g) + id.slice(g.length); };
  const state = (id: string) => { const g = id.replace(STATE_SUFFIX, ''); return game(g) + id.slice(g.length); };
  return {
    game,
    save: <T extends { id: string; gameId: string }>(s: T): T => ({ ...s, id: save(s.id), gameId: game(s.gameId) }),
    state: <T extends { id: string; profile?: string }>(s: T): T => ({ ...s, id: state(s.id), ...(s.profile !== undefined && { profile: save(s.profile) }) }),
    meta: <T extends { id: string; activeSave?: string }>(m: T): T => ({ ...m, id: game(m.id), ...(m.activeSave !== undefined && { activeSave: save(m.activeSave) }) }),
  };
}

/**
 * A backup's ROM record as the library can store it, or null: an id and bytes are required; a title or genre that
 * isn't text (a hand-edited or third-party backup) falls back to the id and 'Unknown' so the library still loads.
 */
export function backupRom(r: unknown): { id: string; title: string; genre: string; data: Uint8Array } | null {
  if (!r || typeof r !== 'object') return null;
  const { id, title, genre, data } = r as Record<string, unknown>;
  if (typeof id !== 'string' || !id || !(data instanceof Uint8Array)) return null;
  const text = (x: unknown, or: string) => (typeof x === 'string' && x.trim() ? x : or);
  return { id, title: text(title, id), genre: text(genre, 'Unknown'), data };
}
