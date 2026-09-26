import { getAllFrom, putInto, STORES, type StoredGameMeta, type StoredRom, type StoredSave, type StoredSaveState, type StoredScreenshot } from './db';
import { SETTINGS_KEYS, useSettingsStore, type SettingsValues } from '../store/settingsStore';

/**
 * A .cartouche backup is JSON: every IndexedDB store plus the settings.
 * Bytes are written as {"$b64": "..."}; Blobs (screenshots) as {"$blob": "...", "type": "image/png"}.
 */
const APP = 'cartouche';
const VERSION = 1;

interface Backup {
  app: typeof APP;
  version: number;
  exported: string;
  settings: Partial<SettingsValues>;
  roms: StoredRom[];
  saves: StoredSave[];
  states: StoredSaveState[];
  meta: StoredGameMeta[];
  screenshots: StoredScreenshot[];
}

function toB64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64: string): Uint8Array {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

async function encode(v: unknown): Promise<unknown> {
  if (v instanceof Uint8Array) return { $b64: toB64(v) };
  if (v instanceof Blob) return { $blob: toB64(new Uint8Array(await v.arrayBuffer())), type: v.type };
  if (Array.isArray(v)) return Promise.all(v.map(encode));
  if (v && typeof v === 'object') return Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k, x]) => [k, await encode(x)])));
  return v;
}
function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.$b64 === 'string') return fromB64(o.$b64);
    if (typeof o.$blob === 'string') return new Blob([fromB64(o.$blob) as BlobPart], { type: typeof o.type === 'string' ? o.type : 'image/png' });
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, decode(x)]));
  }
  return v;
}

/** Everything in this browser as one downloadable file. */
export async function exportBackup(): Promise<Blob> {
  const s = useSettingsStore.getState();
  const [roms, saves, states, meta, screenshots] = await Promise.all([
    getAllFrom(STORES.roms), getAllFrom(STORES.saves), getAllFrom(STORES.states), getAllFrom(STORES.meta), getAllFrom(STORES.screenshots),
  ]);
  const data = await encode({
    app: APP, version: VERSION, exported: new Date().toISOString(),
    settings: Object.fromEntries(SETTINGS_KEYS.map((k) => [k, s[k]])),
    roms, saves, states, meta, screenshots,
  });
  return new Blob([JSON.stringify(data)], { type: 'application/json' });
}

export const backupFileName = () => `cartouche-backup-${new Date().toISOString().slice(0, 10)}.cartouche`;

/** Read and check a backup file. Throws with a readable message when it isn't one. */
export async function readBackup(file: File): Promise<Backup> {
  let raw: unknown;
  try { raw = JSON.parse(await file.text()); } catch { throw new Error(`${file.name} isn’t a Cartouche backup`); }
  const b = decode(raw) as Partial<Backup>;
  // 'cartshelf': backups exported before the app was renamed.
  if (!b || (b.app !== APP && b.app !== 'cartshelf')) throw new Error(`${file.name} isn’t a Cartouche backup`);
  if (b.version !== VERSION) throw new Error(`This backup was made by a newer version of Cartouche`);
  const list = <T,>(x: unknown, ok: (r: T) => boolean) => (Array.isArray(x) ? (x as T[]).filter((r) => r && typeof r === 'object' && ok(r)) : []);
  const str = (x: unknown) => typeof x === 'string' && x.length > 0;
  return {
    app: APP, version: VERSION, exported: String(b.exported ?? ''),
    settings: b.settings && typeof b.settings === 'object' ? b.settings : {},
    roms: list<StoredRom>(b.roms, (r) => str(r.id) && r.data instanceof Uint8Array),
    saves: list<StoredSave>(b.saves, (r) => str(r.id) && r.sram instanceof Uint8Array),
    states: list<StoredSaveState>(b.states, (r) => str(r.id) && r.data instanceof Uint8Array),
    meta: list<StoredGameMeta>(b.meta, (r) => str(r.id)),
    screenshots: list<StoredScreenshot>(b.screenshots, (r) => str(r.gameId) && r.png instanceof Blob),
  };
}

export interface RestoreCount { roms: number; saves: number; screenshots: number }

/**
 * Merge a backup into this browser. Nothing here is lost: a ROM already stored is kept,
 * a save or save state is replaced only by a newer one, favorites and play time are combined.
 * Settings are applied only when asked.
 */
export async function restoreBackup(b: Backup, withSettings: boolean): Promise<RestoreCount> {
  const count: RestoreCount = { roms: 0, saves: 0, screenshots: 0 };
  const [roms, saves, states, meta, shots] = await Promise.all([
    getAllFrom<StoredRom>(STORES.roms), getAllFrom<StoredSave>(STORES.saves), getAllFrom<StoredSaveState>(STORES.states),
    getAllFrom<StoredGameMeta>(STORES.meta), getAllFrom<StoredScreenshot>(STORES.screenshots),
  ]);
  const romIds = new Set(roms.map((r) => r.id));
  for (const r of b.roms) if (!romIds.has(r.id)) { await putInto(STORES.roms, r); count.roms++; }

  const newer = async <T extends { id: string; timestamp: number }>(store: typeof STORES.saves | typeof STORES.states, mine: T[], theirs: T[]) => {
    const at = new Map(mine.map((x) => [x.id, x.timestamp]));
    for (const x of theirs) if ((at.get(x.id) ?? -1) < x.timestamp) { await putInto(store, x); count.saves++; }
  };
  await newer(STORES.saves, saves, b.saves);
  await newer(STORES.states, states, b.states);

  const metaById = new Map(meta.map((m) => [m.id, m]));
  for (const m of b.meta) {
    const o = metaById.get(m.id);
    const max = (a?: number, c?: number) => (a == null ? c : c == null ? a : Math.max(a, c));
    await putInto(STORES.meta, o ? {
      ...o, isFavorite: !!(o.isFavorite || m.isFavorite), totalPlayTime: max(o.totalPlayTime, m.totalPlayTime),
      sessions: max(o.sessions, m.sessions), lastPlayed: max(o.lastPlayed, m.lastPlayed),
      importedAt: o.importedAt ?? m.importedAt,
    } : m);
  }

  const shotKey = (s: StoredScreenshot) => `${s.gameId}@${s.timestamp}`;
  const have = new Set(shots.map(shotKey));
  for (const s of b.screenshots) {
    if (have.has(shotKey(s))) continue;
    await putInto(STORES.screenshots, { gameId: s.gameId, png: s.png, timestamp: s.timestamp }); // new id: never overwrite
    count.screenshots++;
  }

  if (withSettings) {
    const cur = useSettingsStore.getState() as unknown as Record<string, unknown>;
    // Only known keys holding the same kind of value as now (a backup is untrusted input). Box art
    // stays as this browser's player answered: a yes (or "on") from a backup is never theirs here.
    const own = ['showBoxArt', 'boxArtAnswer'];
    const known = Object.fromEntries(Object.entries(b.settings).filter(([k, v]) => (SETTINGS_KEYS as string[]).includes(k) && !own.includes(k) && typeof v === typeof cur[k] && Array.isArray(v) === Array.isArray(cur[k])));
    useSettingsStore.getState().set(known as Partial<SettingsValues>);
  }
  return count;
}
