const DB_NAME = 'gb-emulator';
const DB_VERSION = 4;
const ROM_STORE = 'roms';
const SAVE_STORE = 'saves';
const SAVESTATE_STORE = 'savestates';
const GAME_META_STORE = 'gamemeta';
const SCREENSHOT_STORE = 'screenshots';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ROM_STORE)) db.createObjectStore(ROM_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(SAVE_STORE)) db.createObjectStore(SAVE_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(SAVESTATE_STORE)) db.createObjectStore(SAVESTATE_STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(GAME_META_STORE)) db.createObjectStore(GAME_META_STORE, { keyPath: 'id' });
      // v4: album. Existing stores are kept as they are; only the new one is added.
      if (!db.objectStoreNames.contains(SCREENSHOT_STORE)) db.createObjectStore(SCREENSHOT_STORE, { keyPath: 'id', autoIncrement: true }).createIndex('gameId', 'gameId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txOp<T>(storeName: string, mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = op(tx.objectStore(storeName));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export interface StoredRom { id: string; title: string; genre: string; data: Uint8Array; }
export function saveRom(rom: StoredRom): Promise<void> { return txOp(ROM_STORE, 'readwrite', (s) => s.put(rom)).then(() => {}); }
export function getRom(id: string): Promise<StoredRom | undefined> { return txOp(ROM_STORE, 'readonly', (s) => s.get(id)); }
export function getAllRoms(): Promise<StoredRom[]> { return txOp(ROM_STORE, 'readonly', (s) => s.getAll()); }
export function deleteRom(id: string): Promise<void> { return txOp(ROM_STORE, 'readwrite', (s) => s.delete(id)).then(() => {}); }

export interface StoredSave { id: string; sram: Uint8Array; timestamp: number; }
export function saveSram(save: StoredSave): Promise<void> { return txOp(SAVE_STORE, 'readwrite', (s) => s.put(save)).then(() => {}); }
export function getSram(id: string): Promise<StoredSave | undefined> { return txOp(SAVE_STORE, 'readonly', (s) => s.get(id)); }
export function deleteSave(id: string): Promise<void> { return txOp(SAVE_STORE, 'readwrite', (s) => s.delete(id)).then(() => {}); }

export interface StoredSaveState { id: string; data: Uint8Array; thumbnail: Uint8Array; timestamp: number; }
export function saveSaveState(state: StoredSaveState): Promise<void> { return txOp(SAVESTATE_STORE, 'readwrite', (s) => s.put(state)).then(() => {}); }
export function getSaveState(id: string): Promise<StoredSaveState | undefined> { return txOp(SAVESTATE_STORE, 'readonly', (s) => s.get(id)); }
export function deleteSaveState(id: string): Promise<void> { return txOp(SAVESTATE_STORE, 'readwrite', (s) => s.delete(id)).then(() => {}); }

export interface StoredGameMeta { id: string; isFavorite?: boolean; totalPlayTime?: number; lastPlayed?: number; importedAt?: number; sessions?: number; }
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
  return new Set([...sram.map(String), ...states.map((k) => String(k).replace(SAVESTATE_SUFFIX, ''))]);
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

/** Album: 160×144 PNG screenshots, newest first. */
export interface StoredScreenshot { id?: number; gameId: string; png: Blob; timestamp: number; }
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
