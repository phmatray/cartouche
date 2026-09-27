/**
 * Device sync, this device's side: its records as a manifest, and reading or writing one record by its key
 * (key formats: manifest.ts). Plus the pieces of an interrupted transfer, kept in their own small database
 * so a transfer resumes where it stopped, even after a reload.
 */
import { gameOfSave, getAllFrom, getAllGameMeta, getGameMeta, getRom, getRomIds, getSaveState, getSram, saveSaveState, saveSram, setGameMeta, STORES, type StoredSave, type StoredSaveState } from '../db';
import { importRom } from '../../hooks/useGameLibrary';
import { computeSha1 } from '../rom-utils';
import { useSettingsStore, type SettingsValues } from '../../store/settingsStore';
import type { DisplayConfig } from '../../shaders/filters';
import { digest, pack, unpack } from './crypto';
import { copyName, gamesOf, kindOf, type Entry, type Games, type Manifest, type Play } from './manifest';

/** Settings that follow the player from device to device. Screen size, touch controls, volume, keys, smooth motion
 * (it depends on the display), box art consent and haptics stay with each device. */
export const SYNCED_SETTINGS = ['display', 'channelMutes', 'defaultSpeed', 'rewindBufferSeconds', 'autoSaveEnabled', 'autoSaveIntervalSeconds', 'resumePoints', 'bootRomEnabled'] as const satisfies readonly (keyof SettingsValues)[];

/* ---------- games: this device's ids ↔ the keys both devices share ---------- */

/** SHA-1 → local id of games this device keeps saves of without their ROM (named by another device's manifest). */
const ALIAS = 'cartouche.sync.alias';
export const loadAlias = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(ALIAS) ?? '{}') as Record<string, string>; } catch { return {}; } };
/** Remembers the other device's game ids (the ones already known here keep theirs), so a save stored under one keeps the same key later. */
export function rememberAlias(theirs: Record<string, string>) {
  try { localStorage.setItem(ALIAS, JSON.stringify({ ...theirs, ...loadAlias() })); } catch { /* storage full: keyed by id until it frees */ }
}
/** This device's games, as the keys both devices share. */
export const localGames = async () => gamesOf(await getAllGameMeta(), loadAlias());

const STATE_ID = /^(.*)-(auto|slot-\d+)$/;
export function localId(k: string, games: Games): string | null {
  const rest = k.slice(k.indexOf(':') + 1);
  const [g, tail] = kindOf(k) === 'state' ? rest.split('#') : kindOf(k) === 'sram' ? [rest.split('~')[0], rest.split('~')[1]] : [rest.replace(/^gameDisplay\//, ''), undefined];
  const id = games.id(g);
  if (id === null) return null;
  if (kindOf(k) === 'state') return `${id}-${tail}`;
  if (kindOf(k) === 'sram') return tail ? `${id}~${tail}` : id;
  return id;
}
const sramKey = (id: string, games: Games) => { const [g, sfx] = [gameOfSave(id), id.split('~')[1]]; return `sram:${games.key(g)}${sfx ? `~${sfx}` : ''}`; };
const stateKey = (id: string, games: Games) => { const m = STATE_ID.exec(id); return m ? `state:${games.key(m[1])}#${m[2]}` : null; };

/* ---------- records as they travel ---------- */

interface SramRec { name: string; sram: Uint8Array; timestamp: number; created?: number }
interface StateRec { data: Uint8Array; thumbnail: Uint8Array; timestamp: number; profile: string | null }
interface RomRec { title: string; genre: string; data: Uint8Array }

// As getSram gives it (db.ts asProfile): the name hashed here is the one loadRecord sends.
const nameOf = (s: { name?: unknown }) => (typeof s.name === 'string' && s.name.trim() ? s.name.trim().slice(0, 40) : 'Main');
const hashSram = (r: { name: string; sram: Uint8Array }) => digest(pack({ name: r.name, sram: r.sram }));
const hashState = (r: StateRec) => digest(pack({ data: r.data, thumbnail: r.thumbnail, profile: r.profile }));
const stable = (v: unknown): string => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
export const hashValue = (v: unknown) => digest(new TextEncoder().encode(stable(v)));

function stateRec(s: StoredSaveState, games: Games): StateRec {
  return { data: s.data, thumbnail: s.thumbnail, timestamp: s.timestamp, profile: s.profile ? sramKey(s.profile, games).slice(5) : null };
}

/* ---------- small records remember when they changed ---------- */

const SEEN = 'cartouche.sync.seen';
type Seen = Record<string, [string, number]>;
const loadSeen = (): Seen => { try { return JSON.parse(localStorage.getItem(SEEN) ?? '{}') as Seen; } catch { return {}; } };
const saveSeen = (s: Seen) => { try { localStorage.setItem(SEEN, JSON.stringify(s)); } catch { /* storage full: times are guessed again */ } };

/* ---------- the manifest ---------- */

export interface Snapshot { manifest: Manifest; games: Games; romBytes: number; romCount: number }

export async function readLocal(me: { id: string; name: string }, roms: boolean): Promise<Snapshot> {
  const [metas, romIds, saves, states] = await Promise.all([
    getAllGameMeta(), getRomIds(), getAllFrom<StoredSave>(STORES.saves), getAllFrom<StoredSaveState>(STORES.states),
  ]);
  const games = gamesOf(metas, loadAlias());
  const entries: Entry[] = [];
  const shas: Record<string, string> = {};
  const have = new Set(romIds);
  let romBytes = 0, romCount = 0;
  for (const m of metas) {
    if (!m.rom?.sha1 || !have.has(m.id)) continue;
    shas[m.rom.sha1] = m.id;
    // The header's size byte: 32 KB << n (no need to read megabytes to know it).
    const n = 0x8000 << Math.min(m.rom.head[0x148] ?? 0, 8);
    romBytes += n; romCount++;
    entries.push({ k: `rom:${m.rom.sha1}`, h: m.rom.sha1, t: m.importedAt ?? 0, n });
  }
  for (const s of saves) {
    if (!(s.sram instanceof Uint8Array)) continue;
    entries.push({ k: sramKey(s.id, games), h: await hashSram({ name: nameOf(s), sram: s.sram }), t: s.timestamp, n: s.sram.length + 200 });
  }
  for (const s of states) {
    const k = stateKey(s.id, games);
    if (k && s.data instanceof Uint8Array) entries.push({ k, h: await hashState(stateRec(s, games)), t: s.timestamp, n: s.data.length + (s.thumbnail?.length ?? 0) + 200 });
  }

  // Small records, with the time each was last seen changing here.
  const small: [string, unknown, boolean][] = []; // key, value, is the default
  const settings = useSettingsStore.getState();
  const defaults = useSettingsStore.getInitialState();
  for (const k of SYNCED_SETTINGS) small.push([`set:${k}`, settings[k], stable(settings[k]) === stable(defaults[k])]);
  for (const [id, cfg] of Object.entries(settings.gameDisplay ?? {})) small.push([`set:gameDisplay/${games.key(id)}`, cfg, false]);
  for (const m of metas) {
    const g = games.key(m.id);
    if (m.isFavorite !== undefined) small.push([`fav:${g}`, !!m.isFavorite, !m.isFavorite]);
    if (m.totalPlayTime || m.sessions || m.lastPlayed) {
      const v: Play = {};
      if (m.totalPlayTime) v.time = m.totalPlayTime;
      if (m.sessions) v.sessions = m.sessions;
      if (m.lastPlayed) v.last = m.lastPlayed;
      small.push([`play:${g}`, v, false]);
    }
  }
  const seen = loadSeen(), now = Date.now(), present = new Set<string>();
  for (const [k, v, isDefault] of small) {
    present.add(k);
    const h = await hashValue(v);
    // A value never changed from the default loses to any choice made on the other device.
    if (seen[k]?.[0] !== h) seen[k] = [h, isDefault && !seen[k] ? 0 : now];
    entries.push({ k, h, t: seen[k][1], v });
  }
  // A game's own screen settings removed here ("back to the default"): a deletion the other device should follow.
  for (const [k, [h]] of Object.entries(seen)) {
    if (present.has(k)) continue;
    if (!k.startsWith('set:gameDisplay/')) { delete seen[k]; continue; }
    if (h) seen[k] = ['', now];
    entries.push({ k, h: '', t: seen[k][1] });
  }
  saveSeen(seen);
  return { manifest: { dev: me.id, name: me.name, roms, games: shas, entries }, games, romBytes, romCount };
}

/* ---------- one record ---------- */

/** A record packed for the other device, or null if it's gone since the manifest. */
export async function loadRecord(k: string, games: Games): Promise<Uint8Array | null> {
  const id = localId(k, games);
  if (!id) return null;
  switch (kindOf(k)) {
    case 'rom': {
      const r = await getRom(id);
      return r ? pack({ title: r.title, genre: r.genre, data: r.data } satisfies RomRec) : null;
    }
    case 'sram': {
      const s = await getSram(id);
      return s ? pack({ name: s.name, sram: s.sram, timestamp: s.timestamp, created: s.created } satisfies SramRec) : null;
    }
    case 'state': {
      const s = await getSaveState(id);
      return s ? pack(stateRec(s, games)) : null;
    }
    default: return null;
  }
}

/** The hash `k` has here right now ('' when absent), as the manifest would list it. Saves and states only. */
export async function currentHash(k: string, games: Games): Promise<string> {
  const id = localId(k, games);
  if (!id) return '';
  if (kindOf(k) === 'sram') { const s = await getSram(id); return s?.sram instanceof Uint8Array ? hashSram({ name: nameOf(s), sram: s.sram }) : ''; }
  if (kindOf(k) === 'state') { const s = await getSaveState(id); return s?.data instanceof Uint8Array ? hashState(stateRec(s, games)) : ''; }
  return '';
}

export interface Rename { from: string; at: number }

/**
 * Checks a received record against the hash the manifest promised and stores it under `dest` (renamed when it's
 * the older side of a conflict). false: it didn't match (changed while it travelled): taken again next sync.
 */
export async function storeRecord(k: string, dest: string, hash: string, bytes: Uint8Array, games: () => Promise<Games>, rename?: Rename): Promise<boolean> {
  switch (kindOf(k)) {
    case 'rom': {
      const r = unpack<RomRec>(bytes);
      if (!(r.data instanceof Uint8Array) || (await computeSha1(r.data)) !== hash) return false;
      const out = await importRom(`${String(r.title || 'ROM').replace(/[/\\]/g, ' ')}.${r.data[0x143] & 0x80 ? 'gbc' : 'gb'}`, r.data);
      return out.status !== 'bad';
    }
    case 'sram': {
      const r = unpack<SramRec>(bytes);
      if (!(r.sram instanceof Uint8Array) || typeof r.name !== 'string' || (await hashSram(r)) !== hash) return false;
      const id = localId(dest, await games());
      if (!id) return false;
      await saveSram({ id, gameId: gameOfSave(id), name: rename ? copyName(r.name, rename.from, rename.at) : r.name, sram: r.sram, timestamp: r.timestamp, created: r.created ?? r.timestamp });
      return true;
    }
    case 'state': {
      const r = unpack<StateRec>(bytes);
      if (!(r.data instanceof Uint8Array) || !(r.thumbnail instanceof Uint8Array) || (await hashState(r)) !== hash) return false;
      const g = await games();
      const id = localId(dest, g);
      if (!id) return false;
      const profile = r.profile ? localId(`sram:${r.profile}`, g) ?? undefined : undefined;
      await saveSaveState({ id, data: r.data, thumbnail: r.thumbnail, timestamp: r.timestamp, profile });
      return true;
    }
    default: return false;
  }
}

/** The local side of a conflict, older: copied aside (a save renamed after this device) before the other one lands. */
export async function moveAside(from: string, to: string, games: Games, rename: Rename): Promise<void> {
  const [a, b] = [localId(from, games), localId(to, games)];
  if (!a || !b) return;
  if (kindOf(from) === 'sram') {
    const s = await getSram(a);
    if (s) await saveSram({ ...s, id: b, gameId: gameOfSave(b), name: copyName(s.name, rename.from, rename.at) });
  } else {
    const s = await getSaveState(a);
    if (s) await saveSaveState({ ...s, id: b });
  }
}

/** A small record from the other device (last writer wins; play time merged by the planner). */
export async function writeSmall(k: string, v: unknown, t: number, games: Games): Promise<void> {
  const seen = loadSeen();
  const g = k.slice(k.indexOf(':') + 1);
  if (k.startsWith('set:gameDisplay/')) {
    const id = localId(k, games);
    if (id) useSettingsStore.getState().setGameDisplay(id, v && typeof v === 'object' ? v as DisplayConfig : null);
  } else if (k.startsWith('set:')) {
    const cur = useSettingsStore.getState() as unknown as Record<string, unknown>;
    // Only a known setting holding the same kind of value as here (like a backup's).
    if ((SYNCED_SETTINGS as readonly string[]).includes(g) && typeof v === typeof cur[g] && (v === null) === (cur[g] === null)) useSettingsStore.getState().set({ [g]: v });
  } else {
    const id = games.id(g);
    if (!id) return;
    const m = (await getGameMeta(id)) ?? { id };
    if (kindOf(k) === 'fav') m.isFavorite = v === true;
    else { const p = (v ?? {}) as Play; m.totalPlayTime = p.time; m.sessions = p.sessions; m.lastPlayed = p.last; }
    await setGameMeta(m);
  }
  seen[k] = [v === null ? '' : await hashValue(v), t];
  saveSeen(seen);
}

/* ---------- pieces of an interrupted transfer ---------- */

let partsDb: Promise<IDBDatabase> | null = null;
function parts(): Promise<IDBDatabase> {
  return partsDb ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('cartouche-sync', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('parts', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { partsDb = null; reject(req.error); };
  });
}
const req = <T,>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const store = async (mode: IDBTransactionMode) => (await parts()).transaction('parts', mode).objectStore('parts');
const range = (prefix: string) => IDBKeyRange.bound(prefix, `${prefix}￿`);

/** A transfer's name: which device, which record, which version of it. */
export const partKey = (peer: string, k: string, h: string, t: number) => `${peer}|${k}|${h}|${t}|`;

/** What already arrived of this version (contiguous from 0). Older versions' pieces of the same record are dropped. */
export async function partsOf(prefix: string): Promise<Uint8Array[]> {
  const list = await req((await store('readonly')).getAll(range(prefix))) as { id: string; off: number; data: Uint8Array }[];
  const out: Uint8Array[] = [];
  let at = 0;
  for (const p of list.sort((a, b) => a.off - b.off)) { if (p.off !== at) break; out.push(p.data); at += p.data.length; }
  if (!out.length) await dropParts(prefix.split('|').slice(0, 2).join('|') + '|');
  return out;
}
export async function addPart(prefix: string, off: number, data: Uint8Array): Promise<void> {
  const s = await store('readwrite');
  await req(s.put({ id: `${prefix}${String(off).padStart(10, '0')}`, off, data }));
}
export async function dropParts(prefix: string): Promise<void> {
  await req((await store('readwrite')).delete(range(prefix))).catch(() => {});
}
