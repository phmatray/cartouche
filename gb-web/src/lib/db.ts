import { t } from '../i18n/core';

const DB_NAME = 'gb-emulator';
const DB_VERSION = 5;
const ROM_STORE = 'roms';
const SAVE_STORE = 'saves';
const SAVESTATE_STORE = 'savestates';
const GAME_META_STORE = 'gamemeta';
const SCREENSHOT_STORE = 'screenshots';

/**
 * A tab still holding an older version's connection blocks the upgrade: say so on the page (the app
 * can't render until the database opens), and clear it once the upgrade goes through.
 */
function blockedNotice(show: boolean) {
  const id = 'db-blocked';
  document.getElementById(id)?.remove();
  if (!show) return;
  const el = document.createElement('div');
  el.id = id;
  el.className = 'toasts';
  el.setAttribute('role', 'alert');
  el.innerHTML = `<div class="toast m"><i></i><span>${t('player.error.otherTabs')}</span></div>`;
  document.body.append(el);
}

/** One connection for the tab, closed when another tab upgrades the database (so this tab never blocks it). */
let conn: Promise<IDBDatabase> | null = null;
function openDB(): Promise<IDBDatabase> {
  conn ??= openConnection().then((db) => {
    db.onversionchange = () => { db.close(); conn = null; };
    db.onclose = () => { conn = null; };
    return db;
  }, (e) => { conn = null; throw e; });
  return conn;
}
function openConnection(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onblocked = () => blockedNotice(true);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ROM_STORE)) db.createObjectStore(ROM_STORE, { keyPath: 'id' });
      const saves = db.objectStoreNames.contains(SAVE_STORE) ? req.transaction!.objectStore(SAVE_STORE) : db.createObjectStore(SAVE_STORE, { keyPath: 'id' });
      // v5: save profiles. The one battery save a game had (keyed by the game id) becomes its "Main" profile.
      if (!saves.indexNames.contains('gameId')) saves.createIndex('gameId', 'gameId');
      if (ev.oldVersion < 5) saves.openCursor().onsuccess = (e) => {
        const c = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (!c) return;
        if (!c.value.gameId) c.update(asProfile(c.value));
        c.continue();
      };
      if (!db.objectStoreNames.contains(SAVESTATE_STORE)) db.createObjectStore(SAVESTATE_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(GAME_META_STORE)) db.createObjectStore(GAME_META_STORE, { keyPath: 'id' });
      // v4: album. Existing stores are kept as they are; only the new one is added.
      if (!db.objectStoreNames.contains(SCREENSHOT_STORE)) db.createObjectStore(SCREENSHOT_STORE, { keyPath: 'id', autoIncrement: true }).createIndex('gameId', 'gameId');
    };
    req.onsuccess = () => { blockedNotice(false); resolve(req.result); };
    req.onerror = () => { blockedNotice(false); reject(req.error); };
  });
}

function txOp<T>(storeName: string, mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = op(tx.objectStore(storeName));
    if (mode === 'readwrite') tx.commit?.(); // one request: commit now, not at the next task (a page unloading never gets one)
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export interface StoredRom { id: string; title: string; genre: string; data: Uint8Array; }
export function saveRom(rom: StoredRom): Promise<void> { return txOp(ROM_STORE, 'readwrite', (s) => s.put(rom)).then(() => {}); }
export function getRom(id: string): Promise<StoredRom | undefined> { return txOp(ROM_STORE, 'readonly', (s) => s.get(id)); }
export function getRomIds(): Promise<string[]> { return txOp(ROM_STORE, 'readonly', (s) => s.getAllKeys()).then((k) => k.map(String)); }

/** Run `fn` in one read-write transaction over `stores`: all of it lands, or none (a full disk aborts it whole). */
function inTx<T>(stores: string[], fn: (tx: IDBTransaction, done: (v: T) => void) => void): Promise<T> {
  return openDB().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    let out: T;
    fn(tx, (v) => { out = v; });
    tx.oncomplete = () => resolve(out);
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
  }));
}

/** Store a new ROM and its meta together, under `base` or the first free `base-2`, `base-3`… (never overwrites). Resolves to its id. */
export function addRom(base: string, rom: Omit<StoredRom, 'id'>, meta: Omit<StoredGameMeta, 'id'>): Promise<string> {
  return inTx([ROM_STORE, GAME_META_STORE], (tx, done) => {
    const roms = tx.objectStore(ROM_STORE);
    const attempt = (id: string, n: number) => {
      roms.getKey(id).onsuccess = (e) => {
        if ((e.target as IDBRequest).result !== undefined) return attempt(`${base}-${n}`, n + 1);
        roms.add({ ...rom, id });
        tx.objectStore(GAME_META_STORE).put({ ...meta, id });
        done(id);
      };
    };
    attempt(base, 2);
  });
}

/** Remove a ROM, and the summary of it its meta keeps (favorites and play time stay). */
export function deleteRom(id: string): Promise<void> {
  return inTx([ROM_STORE, GAME_META_STORE], (tx, done) => {
    tx.objectStore(ROM_STORE).delete(id);
    const metas = tx.objectStore(GAME_META_STORE);
    metas.get(id).onsuccess = (e) => {
      const m = (e.target as IDBRequest<StoredGameMeta | undefined>).result;
      if (m?.rom) { delete m.rom; metas.put(m); }
      done(undefined);
    };
  });
}

/**
 * A save profile: one named battery save (cartridge SRAM) of a game. A game can have several
 * ("Main", "Léa's game"…). The game's first one is keyed by the game id itself (the layout before
 * profiles); the others by `${gameId}~${suffix}`. `timestamp` is the last write (last played).
 */
export interface StoredSave { id: string; gameId: string; name: string; sram: Uint8Array; timestamp: number; created?: number; }
export const gameOfSave = (id: string) => id.split('~')[0];
/** Fill in what a save written before profiles (or read from a backup, untrusted) lacks or gets wrong. */
export const asProfile = (s: Omit<StoredSave, 'gameId' | 'name'> & Partial<StoredSave>): StoredSave =>
  ({ ...s, gameId: gameOfSave(s.id), name: typeof s.name === 'string' && s.name.trim() ? s.name.trim().slice(0, 40) : t('player.saves.main') });
export function saveSram(save: StoredSave): Promise<void> { return txOp(SAVE_STORE, 'readwrite', (s) => s.put(save)).then(() => {}); }
export function getSram(id: string): Promise<StoredSave | undefined> { return txOp<StoredSave | undefined>(SAVE_STORE, 'readonly', (s) => s.get(id)).then((r) => r && asProfile(r)); }
export function deleteSave(id: string): Promise<void> { return txOp(SAVE_STORE, 'readwrite', (s) => s.delete(id)).then(() => {}); }

/** Every save profile of a game: Main first, then by creation. (Settings › Storage can use this.) */
export async function listProfiles(gameId: string): Promise<StoredSave[]> {
  const list: StoredSave[] = await txOp(SAVE_STORE, 'readonly', (s) => s.index('gameId').getAll(gameId));
  return list.map(asProfile).sort((a, b) => +(b.id === gameId) - +(a.id === gameId) || (a.created ?? a.timestamp) - (b.created ?? b.timestamp));
}
export const newProfileId = (gameId: string) => `${gameId}~${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** `base`, or `base 2`, `base 3`… when a profile of the game already has that name. */
export function uniqueName(list: StoredSave[], base: string) {
  let name = base;
  for (let n = 2; list.some((p) => p.name === name); n++) name = `${base} ${n}`;
  return name;
}
/** Store a new profile (a copy, an imported .sav). */
export async function createProfile(gameId: string, name: string, sram: Uint8Array): Promise<StoredSave> {
  const now = Date.now();
  const p: StoredSave = { id: newProfileId(gameId), gameId, name, sram, timestamp: now, created: now };
  await saveSram(p);
  return p;
}
/** Write a running game's SRAM to its profile, creating it (named `name`) on the first write. */
export async function writeProfileSram(id: string, sram: Uint8Array, name = t('player.saves.main')): Promise<void> {
  const old = await getSram(id);
  const now = Date.now();
  await saveSram(old ? { ...old, sram, timestamp: now } : { id, gameId: gameOfSave(id), name, sram, timestamp: now, created: now });
}
/** The profile solo play uses: the one chosen on the game page, else Main, else the first. May not exist yet (never saved). */
export async function getActiveProfileId(gameId: string): Promise<string> {
  const [meta, list] = await Promise.all([getGameMeta(gameId), listProfiles(gameId)]);
  return list.find((p) => p.id === meta?.activeSave)?.id ?? list[0]?.id ?? gameId;
}
export async function setActiveProfile(gameId: string, id: string): Promise<void> {
  await setGameMeta({ ...(await getGameMeta(gameId)), id: gameId, activeSave: id });
}

/** `profile`: the save profile the game was writing to when the state was taken (the state holds its SRAM). */
export interface StoredSaveState { id: string; data: Uint8Array; thumbnail: Uint8Array; timestamp: number; profile?: string; }
export function saveSaveState(state: StoredSaveState): Promise<void> { return txOp(SAVESTATE_STORE, 'readwrite', (s) => s.put(state)).then(() => {}); }
export function getSaveState(id: string): Promise<StoredSaveState | undefined> { return txOp(SAVESTATE_STORE, 'readonly', (s) => s.get(id)); }
export function deleteSaveState(id: string): Promise<void> { return txOp(SAVESTATE_STORE, 'readwrite', (s) => s.delete(id)).then(() => {}); }

/**
 * What the library shows of a stored ROM, kept beside it so a launch reads a few hundred bytes per game
 * instead of every ROM (a big collection is gigabytes). `head`: the first 0x150 bytes, the cartridge header.
 */
export interface RomSummary { title: string; genre: string; sha1: string; head: Uint8Array }
export interface StoredGameMeta { id: string; isFavorite?: boolean; totalPlayTime?: number; lastPlayed?: number; importedAt?: number; sessions?: number; activeSave?: string; rom?: RomSummary }
export type GameMeta = StoredGameMeta;
export function getGameMeta(id: string): Promise<StoredGameMeta | undefined> { return txOp(GAME_META_STORE, 'readonly', (s) => s.get(id)); }
export function setGameMeta(meta: StoredGameMeta): Promise<void> { return txOp(GAME_META_STORE, 'readwrite', (s) => s.put(meta)).then(() => {}); }
export function getAllGameMeta(): Promise<StoredGameMeta[]> { return txOp(GAME_META_STORE, 'readonly', (s) => s.getAll()); }

function allKeys(storeName: string): Promise<IDBValidKey[]> { return txOp(storeName, 'readonly', (s) => s.getAllKeys()); }

/** Save-state ids are `${gameId}-slot-${n}`; the resume point written when leaving a game is `${gameId}-auto`. */
export const SLOT_COUNT = 5;
export const resumeStateId = (gameId: string) => `${gameId}-auto`;
export const slotStateId = (gameId: string, i: number) => `${gameId}-slot-${i}`;
const SAVESTATE_SUFFIX = /-(slot-\d+|auto)$/;

/** Ids of games with a cartridge save, a save slot or a resume point. */
export async function getSavedGameIds(): Promise<Set<string>> {
  const [sram, states] = await Promise.all([allKeys(SAVE_STORE), allKeys(SAVESTATE_STORE)]);
  return new Set([...sram.map((k) => gameOfSave(String(k))), ...states.map((k) => String(k).replace(SAVESTATE_SUFFIX, ''))]);
}

/** The most recent resume point or save slot for a game (its thumbnail is the last frame, RGBA 160×144). */
export async function getLatestSaveState(gameId: string): Promise<StoredSaveState | undefined> {
  const states = await getGameSaveStates(gameId);
  return states.filter((s): s is StoredSaveState => !!s).sort((a, b) => b.timestamp - a.timestamp)[0];
}

/** Resume point first, then the slots (undefined where empty). */
export function getGameSaveStates(gameId: string): Promise<(StoredSaveState | undefined)[]> {
  return Promise.all([resumeStateId(gameId), ...Array.from({ length: SLOT_COUNT }, (_, i) => slotStateId(gameId, i))].map(getSaveState));
}

/** Album: 160×144 PNG screenshots, newest first; `kind: 'print'`: a Game Boy Printer strip, 160 × any height. */
export interface StoredScreenshot { id?: number; gameId: string; png: Blob; timestamp: number; kind?: 'print'; }
export function addScreenshot(shot: StoredScreenshot): Promise<void> { return txOp(SCREENSHOT_STORE, 'readwrite', (s) => s.add(shot)).then(() => {}); }
export async function getScreenshots(gameId: string): Promise<StoredScreenshot[]> {
  const list: StoredScreenshot[] = await txOp(SCREENSHOT_STORE, 'readonly', (s) => s.index('gameId').getAll(gameId));
  return list.sort((a, b) => b.timestamp - a.timestamp);
}
export function deleteScreenshot(id: number): Promise<void> { return txOp(SCREENSHOT_STORE, 'readwrite', (s) => s.delete(id)).then(() => {}); }
export async function deleteScreenshots(gameId: string): Promise<void> {
  const ids: IDBValidKey[] = await txOp(SCREENSHOT_STORE, 'readonly', (s) => s.index('gameId').getAllKeys(gameId));
  await Promise.all(ids.map((id) => deleteScreenshot(id as number)));
}

/** Every store, for backup, restore and "erase everything". */
export const STORES = { roms: ROM_STORE, saves: SAVE_STORE, states: SAVESTATE_STORE, meta: GAME_META_STORE, screenshots: SCREENSHOT_STORE } as const;
export type StoreName = typeof STORES[keyof typeof STORES];
export function getAllFrom<T>(store: StoreName): Promise<T[]> { return txOp(store, 'readonly', (s) => s.getAll()); }
export function putInto(store: StoreName, value: unknown): Promise<void> { return txOp(store, 'readwrite', (s) => s.put(value)).then(() => {}); }
export async function clearAll(): Promise<void> {
  const db = await openDB();
  const names = Object.values(STORES);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(names, 'readwrite');
    names.forEach((s) => tx.objectStore(s).clear());
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
