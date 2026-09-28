import { useCallback, useEffect, useMemo } from 'react';
import { create } from 'zustand';
import type { GameEntry, GameLibrary } from '../types/game';
import { addRom, getRomIds, saveRom, getRom, getAllGameMeta, getGameMeta, setGameMeta, eraseGames, getSavedGameIds, type RomSummary, type StoredGameMeta } from '../lib/db';
import { parseRomTitle, parseRomHeader, computeSha1, isGameBoyRom, withoutCopierHeader, titleKey } from '../lib/rom-utils';
import { lookupByHash, type GameDbEntry } from '../lib/gamedb';
import { parseRegion } from '../lib/catalog-utils';
import { assetUrl, TEST_CATEGORY } from '../lib/ui';
import { boxArtAllowed, getCoverArtUrl, needsDownload } from '../lib/cover-art';
import { indexFor } from '../lib/search';
import { inUse } from '../lib/play-lock';
import { useSettingsStore } from '../store/settingsStore';
import { t } from '../i18n';
import catalogData from '../data/catalog.json';

/** ok: added and identified · unk: added, not a known dump · dup: same file already on the shelf · bad: not a Game Boy ROM */
export type ImportStatus = 'ok' | 'unk' | 'dup' | 'bad';
export interface ImportOutcome { status: ImportStatus; id?: string; title?: string; sha1?: string }

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function groupByCategory(games: GameEntry[]): GameLibrary {
  return games.reduce<GameLibrary>((acc,g)=>{ const c=g.category; if(!acc[c])acc[c]=[]; acc[c].push(g); return acc; },{});
}

export { titleKey };

/** `data`: the ROM, or just its header (the first 0x150 bytes): nothing past it is read. */
function localEntry(id: string, title: string, genre: string, data: Uint8Array, sha1: string, dbEntry: GameDbEntry | undefined, importedAt?: number): GameEntry {
  const h = parseRomHeader(data);
  return {
    id, title, description: dbEntry ? `${dbEntry.developer} · ${dbEntry.region}` : '', // '': "User-added ROM" (descOf)
    genre, category: 'My Collection', coverArt: '', screenshots: [],
    romHeaderTitle: parseRomTitle(data) || undefined,
    isLocal: true, importedAt, sha1,
    developer: dbEntry?.developer,
    year: dbEntry?.year || undefined,
    region: dbEntry?.region,
    regions: dbEntry?.region ? parseRegion(`(${dbEntry.region})`) : [],
    players: dbEntry?.players,
    platform: dbEntry?.platform ?? (data[0x143] & 0x80 ? 'gbc' : 'gb'), // unknown dump: the header's CGB flag
    libretroName: dbEntry?.libretroName,
    // Header facts the search filters on (publisher, color support, battery save).
    publisher: h?.publisher || undefined,
    compatibility: h ? ({ 'DMG Only': 'mono', 'CGB Compatible': 'dual', 'CGB Only': 'color' } as const)[h.cgbFlag] : undefined,
    saveType: h ? (/BATTERY/.test(h.cartridgeType) ? 'battery' : 'none') : undefined,
  };
}

/**
 * The catalog entry a user ROM belongs to: same id, same SHA-1 (hosted GB Studio games), same title, or else an
 * unknown dump whose header title starts one catalog title and no other (GB Studio headers: 'OPOSSUMCOUNTR').
 */
function catalogMatch(list: GameEntry[], e: GameEntry) {
  const k = titleKey(e.title);
  const found = list.find((g) => !g.isLocal && (g.id === e.id || (!!e.sha1 && g.sha1 === e.sha1) || catKey(g) === k));
  const h = titleKey(e.romHeaderTitle ?? '');
  if (found || e.developer || h.length < 6) return found;
  const hits = list.filter((g) => !g.isLocal && catKey(g).startsWith(h));
  return hits.length === 1 ? hits[0] : undefined;
}
// A library load matches every user ROM against the whole catalog: each catalog title is folded once, not once per ROM.
const catKeys = new WeakMap<GameEntry, string>();
function catKey(g: GameEntry) {
  let k = catKeys.get(g);
  if (k === undefined) catKeys.set(g, (k = titleKey(g.title)));
  return k;
}

/**
 * Put a user ROM on the shelf. When it matches a catalog entry (same id, or same title) it replaces
 * that entry instead of appearing twice, and keeps the catalog's details.
 */
function withLocal(list: GameEntry[], e: GameEntry): GameEntry[] {
  const cat = catalogMatch(list, e);
  const merged: GameEntry = cat ? {
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
  return [...list.filter((g) => g !== cat && g.id !== e.id), merged];
}

/**
 * The curated catalog: freely licensed homebrew only. Commercial titles are never listed; the
 * GameDB (loaded on demand) only identifies the files a player adds.
 */
const CATALOG = (catalogData as GameEntry[]).map((g) => ({ ...g, regions: g.regions || [] }));
/** The catalog with the GB Studio collection (its own chunk: about a hundred entries the first paint doesn't need). */
const fullCatalog = () => import('../data/gbstudio.json').then((m) => [...CATALOG, ...(m.default as GameEntry[]).map((g) => ({ ...g, regions: [] }))]);

interface LibraryState { games: GameEntry[]; savedIds: Set<string>; loading: boolean; storageError: boolean }
/** One library shared by every screen (it used to be loaded again by each hook call). */
const useLibraryStore = create<LibraryState>(() => ({ games: [], savedIds: new Set(), loading: true, storageError: false }));
const setGames = (fn: (prev: GameEntry[]) => GameEntry[]) => useLibraryStore.setState((s) => ({ games: fn(s.games) }));

let loadPromise: Promise<void> | null = null;
/** The catalog as last loaded: what a removed catalog game goes back to. */
let catalogList: GameEntry[] = CATALOG;
async function loadLibrary() {
  let stored;
  const full = fullCatalog().catch(() => CATALOG); // its chunk failed: the bundled games still show
  try {
    stored = await Promise.all([getRomIds(), getAllGameMeta(), getSavedGameIds()]);
  } catch {
    // Storage blocked (private mode, site data off, some webviews): the bundled games still play.
    useLibraryStore.setState({ games: catalogList = await full, savedIds: new Set(), loading: false, storageError: true });
    return;
  }
  const [romIds, allMeta, savedIds] = stored;
  const metaMap = new Map(allMeta.map((m) => [m.id, m]));

  const roms: [string, RomSummary][] = [];
  for (const id of romIds) { // one at a time: a missing summary reads its ROM, and never all of them at once
    const rom = await romSummary(id, metaMap.get(id));
    if (rom) roms.push([id, rom]);
  }
  const userEntries = await Promise.all(roms.map(async ([id, rom]) => {
    const dbEntry = await lookupByHash(rom.sha1);
    const genre = (rom.genre && rom.genre !== 'Unknown') ? rom.genre : dbEntry?.genre || rom.genre || 'Unknown';
    return localEntry(id, dbEntry?.title || rom.title, genre, rom.head, rom.sha1, dbEntry);
  }));

  const withMeta = (g: GameEntry): GameEntry => {
    const meta = metaMap.get(g.id);
    if (!meta) return g;
    return { ...g, isFavorite: meta.isFavorite, lastPlayed: meta.lastPlayed, totalPlayTime: meta.totalPlayTime, sessions: meta.sessions, importedAt: meta.importedAt };
  };
  // First load: the shelf shows now, the GB Studio collection joins it when its chunk lands (a cold visit on a slow
  // network). `loading` stays on until then: game pages, search and imports wait for the whole catalog.
  const early = useLibraryStore.getState().loading;
  if (early) useLibraryStore.setState({ games: userEntries.reduce(withLocal, CATALOG).map(withMeta), savedIds, storageError: false });
  const catalog = catalogList = await full;
  if (early) setGames((prev) => withCatalog(prev, catalog.slice(CATALOG.length).map(withMeta))); // keeps what changed meanwhile
  else setGames(() => userEntries.reduce(withLocal, catalog).map(withMeta));
  useLibraryStore.setState({ savedIds, loading: false, storageError: false });
}

/** The shelf with more catalog entries: the user ROMs already on it are matched against them again. */
export function withCatalog(shelf: GameEntry[], more: GameEntry[]): GameEntry[] {
  return shelf.filter((g) => g.isLocal).reduce(withLocal, [...shelf.filter((g) => !g.isLocal), ...more]);
}

const summarize = async (title: string, genre: string, data: Uint8Array): Promise<RomSummary> =>
  ({ title, genre, sha1: await computeSha1(data), head: data.slice(0, 0x150), size: data.length });

/** A ROM's summary, from its meta; computed from the ROM once (added before summaries, or restored from a backup) and kept. */
async function romSummary(id: string, meta: StoredGameMeta | undefined): Promise<RomSummary | undefined> {
  if (meta?.rom) return meta.rom;
  const rom = await getRom(id);
  if (!rom) return undefined;
  const summary = await summarize(rom.title, rom.genre, rom.data);
  await setGameMeta({ ...(await getGameMeta(id)), id, rom: summary }).catch(() => {}); // storage full: computed again next time
  return summary;
}

/**
 * Library updates from an import are applied together, a few times a second: one store update per ROM
 * would rebuild the search index and re-render every screen hundreds of times during a big import.
 */
let pending: GameEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;
function flushPending() {
  clearTimeout(flushTimer);
  flushTimer = undefined;
  if (!pending.length) return;
  const add = pending;
  pending = [];
  setGames((prev) => add.reduce(withLocal, prev));
}

/**
 * Another tab of this browser (a browser tab beside the installed app, say) changed the library: it's loaded again
 * here, so this shelf shows the change and an import here knows a ROM just added there (no second copy of it).
 * A burst of changes (a big import there) is one reload; an import here waits for it.
 */
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('cartouche-library') : null;
const changed = () => channel?.postMessage(0);
let reloadQueued = false;
if (channel) channel.onmessage = () => {
  if (!loadPromise || reloadQueued) return; // not loaded yet (the first load reads it all), or a reload is on its way
  reloadQueued = true;
  loadPromise = loadPromise.catch(() => {}).then(() => new Promise((r) => setTimeout(r, 1000))).then(() => { reloadQueued = false; return loadLibrary(); });
};

/** Load the library again from IndexedDB (after a restore or a sync), here and in the other tabs. */
export const reloadLibrary = () => { changed(); return (loadPromise = loadLibrary()); };

export const isRomFile = (name: string) => /\.(gb|gbc|rom|bin)$/i.test(name);

/** The biggest Game Boy ROM: 8 MB (header size byte 8). */
export const MAX_ROM_SIZE = 0x8000 << 8;

/**
 * Add one ROM file's bytes to the library, identified by its SHA-1 against the GameDB.
 * A dump already on the shelf is reported as 'dup' unless `force` stores it again as a second copy.
 * Storage errors (a full disk: QuotaExceededError) are thrown; nothing is half-stored.
 * `id`: the id to store it under when free (sync: the one its saves are already kept under here).
 */
export async function importRom(name: string, data: Uint8Array, force = false, id?: string): Promise<ImportOutcome> {
  data = withoutCopierHeader(data);
  if (!isRomFile(name) || !isGameBoyRom(data)) return { status: 'bad' };
  await (loadPromise ??= loadLibrary());
  const sha1 = await computeSha1(data);
  const onShelf = pending.find((g) => g.sha1 === sha1) ?? useLibraryStore.getState().games.find((g) => g.isLocal && g.sha1 === sha1);
  if (onShelf && !force) return { status: 'dup', id: onShelf.id, title: onShelf.title, sha1 };
  const dbEntry = await lookupByHash(sha1);
  const title = dbEntry?.title || name.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
  const genre = dbEntry?.genre || 'Unknown';
  const importedAt = Date.now();
  const summary = { title, genre, sha1, head: data.slice(0, 0x150), size: data.length };
  const cat = catalogMatch(useLibraryStore.getState().games, localEntry('', title, genre, data, sha1, dbEntry));
  // A catalog game keeps its id (and its page's address) once its file is here.
  const stored = await addRom(cat?.id ?? id ?? (slugify(title) || 'rom'), { title, genre, data }, { importedAt, rom: summary });
  changed();
  const entry = localEntry(stored, title, genre, data, sha1, dbEntry, importedAt);
  const added = withLocal(cat ? [cat] : [], entry).at(-1)!; // as it will show on the shelf
  pending.push(entry);
  flushTimer ??= setTimeout(flushPending, 400);
  // Box art on: fetch it now (no request when off, unrecognized, or the game has its own bundled cover).
  if (needsDownload(added)) getCoverArtUrl(added.libretroName, added.platform);
  return { status: dbEntry || cat ? 'ok' : 'unk', id: stored, title: added.title, sha1 }; // known: a GameDB dump, or a catalog homebrew
}

/** A download that failed or isn't the expected file: its message is for the player. */
export class FetchError extends Error {}
/** A reply that isn't the file: missing (404) or a server failure, not the connection. */
const httpError = (res: Response) => new FetchError(t(res.status === 404 || res.status === 410 ? 'player.error.notFound' : 'player.error.server', { status: res.status }));

/** A hosted catalog ROM (the GB Studio collection), downloaded and checked against its SHA-1; `progress` gets 0..1. */
export async function fetchHosted(game: GameEntry, progress?: (done: number) => void): Promise<Uint8Array> {
  let data: Uint8Array;
  try {
    const res = await fetch(assetUrl(game.romUrl!));
    if (!res.ok) throw httpError(res);
    if (!res.body) throw new Error();
    const total = game.size || Number(res.headers.get('content-length'));
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let got = 0;
    for (const reader = res.body.getReader(); ;) {
      const r = await reader.read();
      if (r.done) break;
      parts.push(r.value);
      got += r.value.length;
      if (total) progress?.(Math.min(1, got / total));
    }
    data = new Uint8Array(await new Blob(parts).arrayBuffer());
  } catch (e) {
    throw e instanceof FetchError ? e : new FetchError(t('player.error.download')); // offline, or cut off midway
  }
  if (game.sha1 && (await computeSha1(data)) !== game.sha1) throw new FetchError(t('add.mismatch'));
  return data;
}

/** Download a hosted game into the library (IndexedDB): it keeps its id and plays offline from then on. */
export const downloadGame = async (game: GameEntry, progress?: (done: number) => void) =>
  importRom(`${game.id}.gb`, await fetchHosted(game, progress));

/** Give a user ROM a new title (for files the GameDB doesn't know). */
export async function renameGame(id: string, title: string) {
  flushPending();
  const [rom, meta] = await Promise.all([getRom(id), getGameMeta(id)]);
  if (!rom) return;
  await saveRom({ ...rom, title });
  if (meta?.rom) await setGameMeta({ ...meta, rom: { ...meta.rom, title } });
  changed();
  setGames((prev) => prev.map((g) => (g.id === id ? { ...g, title } : g)));
}

/** Refresh which games have saves (call after saving or deleting a save). */
export async function refreshSavedIds() {
  useLibraryStore.setState({ savedIds: await getSavedGameIds() });
}

/** Add seconds actually run to a game's stats; `newSession` also counts one more session. */
export async function recordSession(gameId: string, seconds: number, newSession = true) {
  const meta = (await getGameMeta(gameId)) ?? { id: gameId };
  const updated = { ...meta, totalPlayTime: (meta.totalPlayTime ?? 0) + seconds, sessions: (meta.sessions ?? 0) + (newSession ? 1 : 0), lastPlayed: Date.now() };
  await setGameMeta(updated);
  setGames((prev) => prev.map((g) => g.id === gameId ? { ...g, totalPlayTime: updated.totalPlayTime, sessions: updated.sessions, lastPlayed: updated.lastPlayed } : g));
}

/** ROM bytes for a game: the stored copy, else its bundled/hosted URL (resolved against BASE_URL). */
export async function fetchRom(game: GameEntry): Promise<Uint8Array> {
  const stored = await getRom(game.id).catch(() => undefined); // storage blocked: bundled ROMs still load
  if (stored) return stored.data;
  if (game.isLocal) throw new Error(t('player.error.notStored'));
  if (!game.romUrl) throw new Error(`NO_ROM_URL`);
  if (game.madeWith && game.sha1) return fetchHosted(game); // hosted: checked against its SHA-1
  const response = await fetch(assetUrl(game.romUrl)).catch(() => null); // offline: a TypeError in the browser's language
  if (!response) throw new Error(t('player.error.download'));
  if (!response.ok) throw httpError(response);
  return new Uint8Array(await response.arrayBuffer());
}

export function useGameLibrary() {
  const games = useLibraryStore((s) => s.games);
  const loading = useLibraryStore((s) => s.loading);
  const storageError = useLibraryStore((s) => s.storageError);
  const savedIds = useLibraryStore((s) => s.savedIds);
  const library = useMemo(() => groupByCategory(games), [games]);

  useEffect(() => { loadPromise ??= loadLibrary(); }, []);

  /**
   * Erase games' cartridge saves, resume points, slots and albums; the user ROMs among them are removed too, the others
   * stay on the shelf. Any number of games in one pass (one transaction, one library update).
   * false: nothing erased, one of them is open in another tab (its player would write its saves back).
   */
  const removeGames = useCallback(async (list: Pick<GameEntry, 'id' | 'isLocal'>[]) => {
    const { games: open } = await inUse();
    if (list.some((g) => open.includes(g.id))) return false;
    const roms = new Set(list.filter((g) => g.isLocal).map((g) => g.id));
    await eraseGames(list.map((g) => g.id), [...roms]);
    if (roms.size) changed();
    // A catalog game (a downloaded GB Studio ROM keeps the catalog id) goes back to its catalog entry, "on the server".
    // ponytail: a ROM that replaced a catalog entry under another id (same title) brings it back on the next load only.
    if (roms.size) setGames((prev) => prev.flatMap((g) => {
      if (!roms.has(g.id)) return [g];
      const cat = catalogList.find((c) => c.id === g.id);
      return cat ? [{ ...cat, isFavorite: g.isFavorite, lastPlayed: g.lastPlayed, totalPlayTime: g.totalPlayTime, sessions: g.sessions, importedAt: g.importedAt }] : [];
    }));
    await refreshSavedIds();
    return true;
  }, []);
  /** Erase a game's cartridge save, resume point, slots and album; the game stays on the shelf. */
  const eraseSaves = useCallback((gameId: string) => removeGames([{ id: gameId, isLocal: false }]), [removeGames]);
  /** Remove the user's ROM and everything saved for it. */
  const deleteGame = useCallback((gameId: string) => removeGames([{ id: gameId, isLocal: true }]), [removeGames]);

  const toggleFavorite = useCallback(async (gameId: string) => {
    const meta = (await getGameMeta(gameId)) ?? { id: gameId };
    const updated = { ...meta, isFavorite: !meta.isFavorite };
    await setGameMeta(updated);
    setGames((prev) => prev.map((g) => g.id === gameId ? { ...g, isFavorite: updated.isFavorite } : g));
  }, []);

  const linkRomToGame = useCallback(async (game: GameEntry, data: Uint8Array, sha1: string) => {
    const importedAt = Date.now();
    await saveRom({ id: game.id, title: game.title, genre: game.genre, data });
    await setGameMeta({ ...(await getGameMeta(game.id)), id: game.id, importedAt, rom: await summarize(game.title, game.genre, data) });
    changed();
    const dbEntry = await lookupByHash(sha1);
    setGames((prev) => withLocal(prev, localEntry(game.id, game.title, game.genre, data, sha1, dbEntry, importedAt)));
  }, []);

  const fetchRomData = useCallback((game: GameEntry) => fetchRom(game), []);

  const getGameById = useCallback((id: string): GameEntry | undefined => games.find((g) => g.id === id), [games]);

  return { library, games, savedIds, loading, storageError, deleteGame, eraseSaves, removeGames, linkRomToGame, fetchRomData, getGameById, toggleFavorite };
}

/** The search index of the library (shared: built once per library change). */
export function useSearchIndex() {
  const games = useLibraryStore((s) => s.games);
  const savedIds = useLibraryStore((s) => s.savedIds);
  const art = useSettingsStore(boxArtAllowed);
  const tests = useSettingsStore((s) => s.showTests);
  useEffect(() => { loadPromise ??= loadLibrary(); }, []);
  const shown = useMemo(() => (tests ? games : games.filter((g) => g.category !== TEST_CATEGORY)), [games, tests]);
  return useMemo(() => indexFor(shown, savedIds, art), [shown, savedIds, art]);
}
