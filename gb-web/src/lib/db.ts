import { t } from '../i18n/core.ts';
import { markGone } from './sync/gone.ts';

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
    req.onerror = () => reject(req.error);
    if (mode === 'readonly') { req.onsuccess = () => resolve(req.result); return; }
    // A write has landed once the transaction commits: a full disk can still abort it after the request succeeded.
    tx.oncomplete = () => resolve(req.result);
    tx.onabort = () => reject(tx.error ?? req.error ?? new DOMException('Transaction aborted', 'AbortError'));
    tx.commit?.(); // one request: commit now, not at the next task (a page unloading never gets one)
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

/** Store a new ROM and its meta together, under `base` or the first free `base-2`, `base-3`… (never overwrites a ROM; merges into that id's meta). Resolves to its id. */
export function addRom(base: string, rom: Omit<StoredRom, 'id'>, meta: Omit<StoredGameMeta, 'id'>): Promise<string> {
  return inTx([ROM_STORE, GAME_META_STORE], (tx, done) => {
    const roms = tx.objectStore(ROM_STORE);
    const attempt = (id: string, n: number) => {
      roms.getKey(id).onsuccess = (e) => {
        if ((e.target as IDBRequest).result !== undefined) return attempt(`${base}-${n}`, n + 1);
        roms.add({ ...rom, id });
        const metas = tx.objectStore(GAME_META_STORE);
        metas.get(id).onsuccess = (m) => { metas.put(addedMeta((m.target as IDBRequest<StoredGameMeta | undefined>).result, { ...meta, id })); };
        done(id);
      };
    };
    attempt(base, 2);
  });
}

/**
 * The meta of a ROM just stored under an id. A game already known under it (hosted, bundled, synced, or the same ROM
 * removed and added again) keeps its favorite, play time and solo save; another ROM that gets a removed one's id
 * (file names that aren't Latin all become 'rom') starts afresh.
 */
export function addedMeta(old: StoredGameMeta | undefined, meta: StoredGameMeta): StoredGameMeta {
  const { removed, ...kept } = old ?? {};
  return { ...(removed && removed !== meta.rom?.sha1 ? {} : kept), ...meta };
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
  ({ ...s, gameId: gameOfSave(s.id), name: typeof s.name === 'string' && s.name.trim() ? mainName(s.name.trim().slice(0, 40)) : t('player.saves.main') });
/**
 * The default save's name in every language (player.saves.main of each dictionary; a test keeps them in step), with the
 * " 2" a copy gets: it is stored in whichever language was active (or a paired device's), so it is shown in the current one.
 * ponytail: a save a user named exactly "Main" in another language follows the language too.
 */
const MAIN_NAME = /^(?:Main|Principale|Principal)( \d+)?$/;
export const mainName = (name: string) => { const m = MAIN_NAME.exec(name); return m ? t('player.saves.main') + (m[1] ?? '') : name; };
/** The same name whatever the language (sync hashes it: two devices, or one before and after a language change, agree). */
export const neutralName = (name: string) => { const m = MAIN_NAME.exec(name); return m ? 'Main' + (m[1] ?? '') : name; };
export function saveSram(save: StoredSave): Promise<void> { return txOp(SAVE_STORE, 'readwrite', (s) => s.put(save)).then(() => {}); }
export function getSram(id: string): Promise<StoredSave | undefined> { return txOp<StoredSave | undefined>(SAVE_STORE, 'readonly', (s) => s.get(id)).then((r) => r && asProfile(r)); }
/** Deletes stay deleted on paired devices: each leaves a tombstone the sync passes on (lib/sync/gone). */
export function deleteSave(id: string): Promise<void> { return txOp(SAVE_STORE, 'readwrite', (s) => s.delete(id)).then(() => markGone([`sram:${id}`])); }

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
export function deleteSaveState(id: string): Promise<void> { return txOp(SAVESTATE_STORE, 'readwrite', (s) => s.delete(id)).then(() => markGone([`state:${id}`])); }

/**
 * What the library shows of a stored ROM, kept beside it so a launch reads a few hundred bytes per game
 * instead of every ROM (a big collection is gigabytes). `head`: the first 0x150 bytes, the cartridge header.
 * `size`: the ROM's length in bytes (summaries written before it lack it).
 */
export interface RomSummary { title: string; genre: string; sha1: string; head: Uint8Array; size?: number }
/** `removed`: the SHA-1 of the ROM last removed from this id (see addedMeta). */
export interface StoredGameMeta { id: string; isFavorite?: boolean; totalPlayTime?: number; lastPlayed?: number; importedAt?: number; sessions?: number; activeSave?: string; rom?: RomSummary; removed?: string }
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

/**
 * Erase games' save profiles, save states and albums, and for `romIds` also the ROM and its summary (favorites and play
 * time stay), all in one transaction: a few hundred games go in one pass instead of ten transactions each.
 */
export function eraseGames(ids: string[], romIds: string[] = []): Promise<void> {
  const gone: string[] = []; // what existed: tombstones for the sync (deleteSave)
  return inTx([ROM_STORE, GAME_META_STORE, SAVE_STORE, SAVESTATE_STORE, SCREENSHOT_STORE], (tx, done) => {
    const byGame = (name: string, id: string) => {
      const store = tx.objectStore(name);
      store.index('gameId').getAllKeys(id).onsuccess = (e) => {
        for (const k of (e.target as IDBRequest<IDBValidKey[]>).result) { store.delete(k); if (name === SAVE_STORE) gone.push(`sram:${String(k)}`); }
      };
    };
    const states = tx.objectStore(SAVESTATE_STORE);
    for (const id of ids) {
      byGame(SAVE_STORE, id);
      byGame(SCREENSHOT_STORE, id);
      [resumeStateId(id), ...Array.from({ length: SLOT_COUNT }, (_, i) => slotStateId(id, i))].forEach((k) => {
        states.getKey(k).onsuccess = (e) => { if ((e.target as IDBRequest).result !== undefined) { states.delete(k); gone.push(`state:${k}`); } };
      });
    }
    const roms = tx.objectStore(ROM_STORE), metas = tx.objectStore(GAME_META_STORE);
    for (const id of romIds) {
      roms.delete(id);
      metas.get(id).onsuccess = (e) => {
        const m = (e.target as IDBRequest<StoredGameMeta | undefined>).result;
        if (m?.rom) { m.removed = m.rom.sha1; gone.push(`rom:${m.rom.sha1}`); delete m.rom; metas.put(m); }
      };
    }
    done(undefined);
  }).then(() => markGone(gone));
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
