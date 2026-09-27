import { t } from '../i18n';
import { decode, jsonBlob, splitJson } from './backup-json';
import { mover, placeRom } from './backup-merge';
import { computeSha1 } from './rom-utils';
import { asProfile, getAllFrom, getAllGameMeta, getRom, getRomIds, putInto, STORES, type StoredGameMeta, type StoredRom, type StoredSave, type StoredSaveState, type StoredScreenshot } from './db';
import { cleanSetting } from './settings-clean';
import { SETTINGS_KEYS, displayFromV3, useSettingsStore, type SettingsValues } from '../store/settingsStore';

/** A .cartouche backup is JSON (see ./backup-json): every IndexedDB store plus the settings. */
const APP = 'cartouche';
const VERSION = 1;

interface Backup {
  app: typeof APP;
  version: number;
  exported: string;
  settings: Partial<SettingsValues>;
  /** How many ROMs the file holds. */
  romCount: number;
  /** Read one at a time when restored (a big library's ROMs don't fit in memory at once); null: not a valid ROM. */
  roms: (() => Promise<StoredRom | null>)[];
  saves: StoredSave[];
  states: StoredSaveState[];
  meta: StoredGameMeta[];
  screenshots: StoredScreenshot[];
}

/** Everything in this browser as one downloadable file. The ROMs are read one at a time (a library can be gigabytes). */
export async function exportBackup(): Promise<Blob> {
  const s = useSettingsStore.getState();
  const [saves, states, meta, screenshots] = await Promise.all([
    getAllFrom(STORES.saves), getAllFrom(STORES.states), getAllFrom(STORES.meta), getAllFrom(STORES.screenshots),
  ]);
  const head = {
    app: APP, version: VERSION, exported: new Date().toISOString(),
    settings: Object.fromEntries(SETTINGS_KEYS.map((k) => [k, s[k]])),
    saves, states, meta, screenshots,
  };
  return jsonBlob(head, 'roms', (async function* () {
    for (const id of await getRomIds()) { const r = await getRom(id); if (r) yield r; }
  })());
}

export const backupFileName = () => `cartouche-backup-${new Date().toISOString().slice(0, 10)}.cartouche`;

const str = (x: unknown) => typeof x === 'string' && x.length > 0;

/** Read and check a backup file. Throws with a readable message when it isn't one. */
export async function readBackup(file: File): Promise<Backup> {
  const notBackup = () => new Error(t('settings.storage.notBackup', { file: file.name }));
  let raw: unknown, items: [number, number][];
  try { ({ head: raw, items } = await splitJson(file, 'roms')); } catch (e) {
    // SyntaxError: not JSON. RangeError: a head or a ROM past what this browser can hold. Else: the file couldn't be read.
    throw e instanceof SyntaxError ? notBackup()
      : new Error(t(e instanceof RangeError ? 'settings.storage.tooBig' : 'settings.storage.unreadable', { file: file.name }), { cause: e });
  }
  const b = decode(raw) as Partial<Omit<Backup, 'roms'>>;
  // 'cartshelf': backups exported before the app was renamed.
  if (!b || (b.app !== APP && b.app !== 'cartshelf')) throw notBackup();
  if (b.version !== VERSION) throw new Error(t('settings.storage.newer'));
  const list = <T,>(x: unknown, ok: (r: T) => boolean) => (Array.isArray(x) ? (x as T[]).filter((r) => r && typeof r === 'object' && ok(r)) : []);
  return {
    app: APP, version: VERSION, exported: String(b.exported ?? ''),
    settings: b.settings && typeof b.settings === 'object' ? b.settings : {},
    romCount: items.length,
    roms: items.map(([start, end]) => async () => {
      const r = decode(JSON.parse(await file.slice(start, end).text())) as StoredRom;
      return r && typeof r === 'object' && str(r.id) && r.data instanceof Uint8Array ? r : null;
    }),
    // Save profiles; a backup from before profiles has one save per game, which becomes its "Main".
    saves: list<StoredSave>(b.saves, (r) => str(r.id) && r.sram instanceof Uint8Array).map(asProfile),
    states: list<StoredSaveState>(b.states, (r) => str(r.id) && r.data instanceof Uint8Array && (r.profile === undefined || str(r.profile))),
    meta: list<StoredGameMeta>(b.meta, (r) => str(r.id)),
    screenshots: list<StoredScreenshot>(b.screenshots, (r) => str(r.gameId) && r.png instanceof Blob),
  };
}

export interface RestoreCount { roms: number; saves: number; screenshots: number }

/**
 * Merge a backup into this browser. Nothing here is lost: a ROM already stored is kept,
 * a save or save state is replaced only by a newer one, favorites and play time are combined.
 * ROMs are matched by SHA-1: a backup game whose id is taken here by another game gets a free id, its saves with it.
 * Settings are applied only when asked. `count` is filled as it goes (a full disk stops it midway: it says what landed).
 */
export async function restoreBackup(b: Backup, withSettings: boolean, count: RestoreCount = { roms: 0, saves: 0, screenshots: 0 }): Promise<RestoreCount> {
  const [romIds, saves, states, meta, shots] = await Promise.all([
    getRomIds(), getAllFrom<StoredSave>(STORES.saves), getAllFrom<StoredSaveState>(STORES.states),
    getAllGameMeta(), getAllFrom<StoredScreenshot>(STORES.screenshots),
  ]);
  const moved = new Map<string, string>();
  if (b.roms.length) {
    const here = new Map<string, string>(); // id → SHA-1
    const claimed = new Set<string>();
    const summaries = new Map(meta.map((m) => [m.id, m.rom?.sha1]));
    for (const id of romIds) { // from the summaries; a ROM without one yet is read alone
      here.set(id, summaries.get(id) ?? await getRom(id).then((r) => (r ? computeSha1(r.data) : '')));
    }
    for (const read of b.roms) {
      const r = await read();
      if (!r) continue;
      const to = placeRom(r.id, await computeSha1(r.data), here, claimed);
      if (to.id !== r.id) moved.set(r.id, to.id);
      if (to.store) { await putInto(STORES.roms, { ...r, id: to.id }); count.roms++; }
    }
  }
  const move = mover(moved);

  const newer = async <T extends { id: string; timestamp: number }>(store: typeof STORES.saves | typeof STORES.states, mine: T[], theirs: T[]) => {
    const at = new Map(mine.map((x) => [x.id, x.timestamp]));
    for (const x of theirs) if ((at.get(x.id) ?? -1) < x.timestamp) { await putInto(store, x); count.saves++; }
  };
  await newer(STORES.saves, saves, b.saves.map(move.save));
  await newer(STORES.states, states, b.states.map(move.state));

  const metaById = new Map(meta.map((m) => [m.id, m]));
  for (const m of b.meta.map(move.meta)) {
    const o = metaById.get(m.id);
    const max = (a?: number, c?: number) => (a == null ? c : c == null ? a : Math.max(a, c));
    await putInto(STORES.meta, o ? {
      ...o, isFavorite: !!(o.isFavorite || m.isFavorite), totalPlayTime: max(o.totalPlayTime, m.totalPlayTime),
      sessions: max(o.sessions, m.sessions), lastPlayed: max(o.lastPlayed, m.lastPlayed),
      importedAt: o.importedAt ?? m.importedAt,
    } : { ...m, rom: undefined }); // a backup's ROM summary is untrusted: the next launch computes it from the ROM itself
  }

  const shotKey = (s: StoredScreenshot) => `${s.gameId}@${s.timestamp}`;
  const have = new Set(shots.map(shotKey));
  for (const s of b.screenshots.map((x) => ({ ...x, gameId: move.game(x.gameId) }))) {
    if (have.has(shotKey(s))) continue;
    // A new id: never overwrite. A Game Boy Printer strip stays one.
    await putInto(STORES.screenshots, { gameId: s.gameId, png: s.png, timestamp: s.timestamp, ...(s.kind === 'print' && { kind: 'print' }) });
    count.screenshots++;
  }

  if (withSettings) {
    const cur = useSettingsStore.getState() as unknown as Record<string, unknown>;
    // Only known keys holding the same kind of value as now (a backup is untrusted input). Box art
    // stays as this browser's player answered: a yes (or "on") from a backup is never theirs here.
    const own = ['showBoxArt', 'boxArtAnswer'];
    // A backup from before settings v4 has the screen style as shaderPreset + pixelGrid: convert it like the store migration.
    const raw = b.settings as Record<string, unknown>;
    const settings = raw.display === undefined && ('shaderPreset' in raw || 'pixelGrid' in raw)
      ? { ...raw, display: displayFromV3(raw.shaderPreset, raw.pixelGrid) } : raw;
    const known = Object.fromEntries(Object.entries(settings)
      .filter(([k, v]) => (SETTINGS_KEYS as string[]).includes(k) && !own.includes(k) && typeof v === typeof cur[k] && (v === null) === (cur[k] === null) && Array.isArray(v) === Array.isArray(cur[k]))
      .map(([k, v]) => [k, cleanSetting(k, v, cur[k])]) // records checked field by field: a partial keybindings would break the player
      .filter(([, v]) => v !== undefined));
    useSettingsStore.getState().set(known as Partial<SettingsValues>);
  }
  return count;
}
