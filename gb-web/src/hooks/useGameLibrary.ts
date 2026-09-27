import { useCallback, useEffect, useMemo } from 'react';
import { create } from 'zustand';
import type { GameEntry, GameLibrary } from '../types/game';
import { addRom, getRomIds, saveRom, deleteRom, getRom, getAllGameMeta, getGameMeta, setGameMeta, deleteSave, deleteSaveState, deleteScreenshots, getSavedGameIds, listProfiles, resumeStateId, slotStateId, SLOT_COUNT, type RomSummary, type StoredGameMeta } from '../lib/db';
import { parseRomTitle, parseRomHeader, computeSha1, isGameBoyRom } from '../lib/rom-utils';
import { lookupByHash, type GameDbEntry } from '../lib/gamedb';
import { parseRegion } from '../lib/catalog-utils';
import { assetUrl } from '../lib/ui';
import { boxArtAllowed, getCoverArtUrl, needsDownload } from '../lib/cover-art';
import { indexFor } from '../lib/search';
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

export const titleKey = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

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
    publisher: h && !h.publisher.startsWith('Unknown') ? h.publisher : undefined,
    compatibility: h ? ({ 'DMG Only': 'mono', 'CGB Compatible': 'dual', 'CGB Only': 'color' } as const)[h.cgbFlag] : undefined,
    saveType: h ? (/BATTERY/.test(h.cartridgeType) ? 'battery' : 'none') : undefined,
  };
}

const catalogMatch = (list: GameEntry[], e: GameEntry) => {
  const k = titleKey(e.title);
  return list.find((g) => !g.isLocal && (g.id === e.id || titleKey(g.title) === k));
};

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

interface LibraryState { games: GameEntry[]; savedIds: Set<string>; loading: boolean; storageError: boolean }
/** One library shared by every screen (it used to be loaded again by each hook call). */
const useLibraryStore = create<LibraryState>(() => ({ games: [], savedIds: new Set(), loading: true, storageError: false }));
const setGames = (fn: (prev: GameEntry[]) => GameEntry[]) => useLibraryStore.setState((s) => ({ games: fn(s.games) }));

let loadPromise: Promise<void> | null = null;
async function loadLibrary() {
  let stored;
  try {
    stored = await Promise.all([getRomIds(), getAllGameMeta(), getSavedGameIds()]);
  } catch {
    // Storage blocked (private mode, site data off, some webviews): the bundled games still play.
    useLibraryStore.setState({ games: CATALOG, savedIds: new Set(), loading: false, storageError: true });
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

  const all = userEntries.reduce(withLocal, CATALOG).map((g) => {
    const meta = metaMap.get(g.id);
    if (!meta) return g;
    return { ...g, isFavorite: meta.isFavorite, lastPlayed: meta.lastPlayed, totalPlayTime: meta.totalPlayTime, sessions: meta.sessions, importedAt: meta.importedAt };
  });

  useLibraryStore.setState({ games: all, savedIds, loading: false, storageError: false });
}

const summarize = async (title: string, genre: string, data: Uint8Array): Promise<RomSummary> =>
  ({ title, genre, sha1: await computeSha1(data), head: data.slice(0, 0x150) });

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

/** Load the library again from IndexedDB (after a restore). */
export const reloadLibrary = () => (loadPromise = loadLibrary());

export const isRomFile = (name: string) => /\.(gb|gbc|rom|bin)$/i.test(name);

/** The biggest Game Boy ROM: 8 MB (header size byte 8). */
export const MAX_ROM_SIZE = 0x8000 << 8;

/**
 * Add one ROM file's bytes to the library, identified by its SHA-1 against the GameDB.
 * A dump already on the shelf is reported as 'dup' unless `force` stores it again as a second copy.
 * Storage errors (a full disk: QuotaExceededError) are thrown; nothing is half-stored.
 */
export async function importRom(name: string, data: Uint8Array, force = false): Promise<ImportOutcome> {
  if (!isRomFile(name) || !isGameBoyRom(data)) return { status: 'bad' };
  await (loadPromise ??= loadLibrary());
  const sha1 = await computeSha1(data);
  const onShelf = pending.find((g) => g.sha1 === sha1) ?? useLibraryStore.getState().games.find((g) => g.isLocal && g.sha1 === sha1);
  if (onShelf && !force) return { status: 'dup', id: onShelf.id, title: onShelf.title, sha1 };
  const dbEntry = await lookupByHash(sha1);
  const title = dbEntry?.title || name.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
  const genre = dbEntry?.genre || 'Unknown';
  const importedAt = Date.now();
  const summary = { title, genre, sha1, head: data.slice(0, 0x150) };
  const id = await addRom(slugify(title) || 'rom', { title, genre, data }, { importedAt, rom: summary });
  const entry = localEntry(id, title, genre, data, sha1, dbEntry, importedAt);
  const cat = catalogMatch(useLibraryStore.getState().games, entry);
  const added = withLocal(cat ? [cat] : [], entry).at(-1)!; // as it will show on the shelf
  pending.push(entry);
  flushTimer ??= setTimeout(flushPending, 400);
  // Box art on: fetch it now (no request when off, unrecognized, or the game has its own bundled cover).
  if (needsDownload(added)) getCoverArtUrl(added.libretroName, added.platform);
  return { status: dbEntry || cat ? 'ok' : 'unk', id, title: added.title, sha1 }; // known: a GameDB dump, or a catalog homebrew
}

/** Give a user ROM a new title (for files the GameDB doesn't know). */
export async function renameGame(id: string, title: string) {
  flushPending();
  const [rom, meta] = await Promise.all([getRom(id), getGameMeta(id)]);
  if (!rom) return;
  await saveRom({ ...rom, title });
  if (meta?.rom) await setGameMeta({ ...meta, rom: { ...meta.rom, title } });
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
  const response = await fetch(assetUrl(game.romUrl)).catch(() => null); // offline: a TypeError in the browser's language
  if (!response?.ok) throw new Error(t('player.error.download'));
  return new Uint8Array(await response.arrayBuffer());
}

export function useGameLibrary() {
  const games = useLibraryStore((s) => s.games);
  const loading = useLibraryStore((s) => s.loading);
  const storageError = useLibraryStore((s) => s.storageError);
  const savedIds = useLibraryStore((s) => s.savedIds);
  const library = useMemo(() => groupByCategory(games), [games]);

  useEffect(() => { loadPromise ??= loadLibrary(); }, []);

  /** Erase a game's cartridge save, resume point, slots and album; the game stays on the shelf. */
  const eraseSaves = useCallback(async (gameId: string) => {
    await Promise.all([
      listProfiles(gameId).then((ps) => Promise.all(ps.map((p) => deleteSave(p.id)))),
      deleteSaveState(resumeStateId(gameId)),
      ...Array.from({ length: SLOT_COUNT }, (_, i) => deleteSaveState(slotStateId(gameId, i))),
      deleteScreenshots(gameId),
    ]);
    await refreshSavedIds();
  }, []);

  /** Remove the user's ROM and everything saved for it. */
  const deleteGame = useCallback(async (gameId: string) => {
    await Promise.all([deleteRom(gameId), eraseSaves(gameId)]);
    // ponytail: the catalog entry a ROM replaced comes back on the next library load, not immediately.
    setGames((prev) => prev.filter((g) => g.id !== gameId));
  }, [eraseSaves]);

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
    const dbEntry = await lookupByHash(sha1);
    setGames((prev) => withLocal(prev, localEntry(game.id, game.title, game.genre, data, sha1, dbEntry, importedAt)));
  }, []);

  const fetchRomData = useCallback((game: GameEntry) => fetchRom(game), []);

  const getGameById = useCallback((id: string): GameEntry | undefined => games.find((g) => g.id === id), [games]);

  return { library, games, savedIds, loading, storageError, deleteGame, eraseSaves, linkRomToGame, fetchRomData, getGameById, toggleFavorite };
}

/** The search index of the library (shared: built once per library change). */
export function useSearchIndex() {
  const games = useLibraryStore((s) => s.games);
  const savedIds = useLibraryStore((s) => s.savedIds);
  const art = useSettingsStore(boxArtAllowed);
  useEffect(() => { loadPromise ??= loadLibrary(); }, []);
  return useMemo(() => indexFor(games, savedIds, art), [games, savedIds, art]);
}
