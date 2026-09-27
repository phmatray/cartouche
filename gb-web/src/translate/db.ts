/**
 * Live translate's own IndexedDB database (apart from the library's, so neither ever blocks the other's
 * upgrades): translations already made, and the characters learned for each game.
 */
const DB_NAME = 'cartouche-translate';
const LINES = 'lines', GLYPHS = 'glyphs';

let conn: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  conn ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(LINES, { keyPath: 'id' });
      req.result.createObjectStore(GLYPHS, { keyPath: 'gameId' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); conn = null; };
      resolve(db);
    };
    req.onerror = () => { conn = null; reject(req.error); };
  });
  return conn;
}

function op<T>(store: string, mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const req = f(db.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export interface StoredLine { id: string; gameId: string; translation: string; by: string; at: number }
const lineId = (gameId: string, lang: string, text: string) => `${gameId}\u0001${lang}\u0001${text}`;

export const getLine = (gameId: string, lang: string, text: string) =>
  op<StoredLine | undefined>(LINES, 'readonly', (s) => s.get(lineId(gameId, lang, text))).catch(() => undefined);
export const putLine = (gameId: string, lang: string, text: string, translation: string, by: string) =>
  op(LINES, 'readwrite', (s) => s.put({ id: lineId(gameId, lang, text), gameId, translation, by, at: Date.now() } satisfies StoredLine)).catch(() => {});

/** Bitmap key -> character ('' = not text), taught by the player or confirmed by the translator. */
export const getGlyphs = (gameId: string) =>
  op<{ gameId: string; map: Record<string, string> } | undefined>(GLYPHS, 'readonly', (s) => s.get(gameId)).then((r) => r?.map ?? {}).catch(() => ({}));
export const putGlyphs = (gameId: string, map: Record<string, string>) =>
  op(GLYPHS, 'readwrite', (s) => s.put({ gameId, map })).catch(() => {});
