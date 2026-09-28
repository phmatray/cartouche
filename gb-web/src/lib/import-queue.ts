import { create } from 'zustand';
import { FetchError, fetchHosted, importRom, isRomFile, MAX_ROM_SIZE, type ImportOutcome, type ImportStatus } from '../hooks/useGameLibrary';
import type { GameEntry } from '../types/game';
import { toast } from '../components/shell/actions';
import { crc32, listZip, readEntry, ZipError } from './zip';
import { applyPatch, PatchError, patchKind, patchSource, type PatchKind } from './patch';
import { getAllGameMeta, getRom } from './db';
import { computeSha1 } from './rom-utils';
import { t } from '../i18n';

/**
 * The import queue: files dropped anywhere in the app or chosen on the Add ROMs page, and the ROMs inside
 * .zip archives, checked and stored one at a time. It lives outside the page, so an import keeps going
 * (and the header shows its progress) while the player browses the library.
 */
/** base: a patch waiting for the ROM it applies to. */
export type RowState = ImportStatus | 'work' | 'stop' | 'base';
export interface ImportRow {
  key: string; name: string; size: number; st: RowState;
  /** The archive it comes from. */
  from?: string;
  /** A patch file (IPS, BPS, UPS), and the library game it was applied to. */
  patch?: PatchKind; base?: string;
  note?: string; id?: string; title?: string; sha1?: string;
  read?: () => Promise<Uint8Array>;
}
/** Storage ran out (or failed some other way: `other`): what the browser reported (bytes; 0 when it doesn't say). */
export interface Full { usage: number; quota: number; other?: boolean }
interface State { rows: ImportRow[]; ignored: number; full: Full | null }
export const useImports = create<State>(() => ({ rows: [], ignored: 0, full: null }));

// Row updates land together a few times a second: one re-render per ROM would crawl on a list of thousands.
const patches = new Map<string, Partial<ImportRow>>();
let timer: ReturnType<typeof setTimeout> | undefined;
function flush() {
  clearTimeout(timer);
  timer = undefined;
  if (!patches.size) return;
  const ps = new Map(patches);
  patches.clear();
  useImports.setState((s) => ({ rows: s.rows.map((r) => { const p = ps.get(r.key); return p ? { ...r, ...p } : r; }) }));
}
export function patchRow(key: string, p: Partial<ImportRow>, now = false) {
  patches.set(key, { ...patches.get(key), ...p });
  if (now) flush();
  else timer ??= setTimeout(flush, 150);
}

const asRow = (o: ImportOutcome): Partial<ImportRow> => ({ st: o.status, id: o.id, title: o.title, sha1: o.sha1 });
/** Folders, macOS metadata (__MACOSX/, ._ files, .DS_Store) and other hidden files: not listed, just counted. */
export const HIDDEN = /(^|\/)(__MACOSX\/|\.)/;
let seq = 0;

/** A zip inside a zip (a folder of per-game .zip files, compressed on an iPhone) is opened too, one level deep. */
const INNER_ZIP_MAX = 64 << 20;

async function expand(files: File[]): Promise<{ rows: ImportRow[]; ignored: number }> {
  const rows: ImportRow[] = [];
  let ignored = 0;
  const bad = (name: string, size: number, err: unknown, from?: string) =>
    rows.push({ key: String(++seq), name, size, from, st: 'bad', note: err instanceof ZipError ? err.message : t('add.unreadable') });
  const zip = async (z: Blob, label: string, nested: boolean) => {
    for (const e of await listZip(z)) {
      if (e.name.endsWith('/') || HIDDEN.test(e.name)) { ignored++; continue; }
      const name = e.name.split('/').pop()!;
      if (/\.zip$/i.test(name)) {
        if (nested || e.size > INNER_ZIP_MAX) { rows.push({ key: String(++seq), name, size: e.size, from: label, st: 'bad', note: t('add.zip.nested') }); continue; }
        try { await zip(new Blob([await readEntry(z, e) as BlobPart]), `${label} › ${name}`, true); } catch (err) { bad(name, e.size, err, label); }
        continue;
      }
      rows.push({ key: String(++seq), name, size: e.size, from: label, st: 'work', patch: patchKind(name) ?? undefined, read: () => readEntry(z, e) });
    }
  };
  for (const f of files) {
    if (!/\.zip$/i.test(f.name)) {
      rows.push({ key: String(++seq), name: f.name, size: f.size, st: 'work', patch: patchKind(f.name) ?? undefined, read: async () => new Uint8Array(await f.arrayBuffer()) });
      continue;
    }
    const before = rows.length;
    try { await zip(f, f.name, false); } catch (err) { bad(f.name, f.size, err); }
    // Nothing in it to try (only folders and system files): said, not a drop that shows nothing at all.
    if (rows.length === before) bad(f.name, f.size, new ZipError(t('add.zip.empty')));
  }
  return { rows, ignored };
}

/** Bumped by Stop (and by a full disk): everything queued before it stops. */
let gen = 0;
let chain = Promise.resolve();
let queued = 0;
/** The row being stored right now: Stop lets it finish. */
let current: string | null = null;
const stopWaiting = () => useImports.setState((s) => ({ rows: s.rows.map((r) => ((r.st === 'work' || r.st === 'base') && r.key !== current ? { ...r, st: 'stop' } : r)) }));

export function queueImport(files: File[]) {
  if (files.length) run(() => expand(files));
}

/** Download hosted catalog games (the GB Studio collection) through the same queue: one at a time, Stop, full-disk handling. */
export function queueDownloads(games: GameEntry[]) {
  if (games.length) run(async () => ({
    rows: games.map((g): ImportRow => ({ key: String(++seq), name: `${g.id}.gb`, size: g.size ?? 0, title: g.title, st: 'work', read: () => fetchHosted(g) })),
    ignored: 0,
  }));
}

function run(list: () => Promise<{ rows: ImportRow[]; ignored: number }>) {
  const my = gen;
  // Dropped while another import runs: its rows join the list instead of replacing it.
  const append = queued > 0;
  queued++;
  chain = chain.then(async () => {
    if (my !== gen) return;
    const { rows: fresh, ignored } = await list();
    flush();
    useImports.setState((s) => (append
      ? { rows: [...s.rows, ...fresh], ignored: s.ignored + ignored }
      : { rows: fresh, ignored, full: null }));
    let added = 0;
    /** The library ids of this batch's ROMs: where its patches look for their base first. */
    const batch: string[] = [];
    // Patches after the ROMs, so a patch dropped with its ROM finds it.
    for (const r of [...fresh.filter((f) => !f.patch), ...fresh.filter((f) => f.patch)]) {
      if (my !== gen) break;
      if (r.st !== 'work') continue;
      current = r.key;
      let out: Partial<ImportRow>;
      let data: Uint8Array | undefined;
      try {
        if ((isRomFile(r.name) || r.patch) && r.size <= MAX_ROM_SIZE * (r.patch ? 2 : 1)) data = await r.read!();
        out = { st: 'bad' };
      } catch (e) {
        out = { st: 'bad', note: e instanceof ZipError ? e.message.toLowerCase() : e instanceof FetchError ? e.message : t('add.unreadable') };
      }
      if (data) {
        // A file that was read but couldn't be stored: the storage is failing, so every next ROM would too.
        try { out = r.patch ? await patched(r, data, batch) : asRow(await importRom(r.name, data)); } catch (e) { await storageFull(e); break; }
        if (!r.patch && out.id && out.st !== 'bad') batch.push(out.id);
      }
      if (out.st === 'ok' || out.st === 'unk') added++;
      patchRow(r.key, out, my !== gen); // stopped meanwhile: show it at once
    }
    current = null;
    flush();
    if (my !== gen) stopWaiting(); // stopped while this batch was being listed
    if (added) toast(t('add.toast.added', { count: added }), 'c');
  }).catch(() => {}).finally(() => { queued--; });
}

/** A patch row: applied at once when its base is here (BPS/UPS name it by size and CRC32), else it waits for one to be chosen. */
async function patched(r: ImportRow, p: Uint8Array, batch: string[]): Promise<Partial<ImportRow>> {
  const src = patchSource(p);
  if (!src && r.patch !== 'ips') return { st: 'bad', note: t('add.patch.broken') };
  const base = src && await findBase(src.size, src.crc32, batch);
  return base ? applyTo(r, p, base) : { st: 'base' };
}

/** The library ROM of that size and CRC32: this batch's first, then the others (only ROMs of that size are read). */
async function findBase(size: number, crc: number, batch: string[]): Promise<string | undefined> {
  const ids = (await getAllGameMeta()).filter((m) => m.rom?.size === size).map((m) => m.id);
  // ponytail: every stored ROM of that size is read for its CRC32; keep the CRC in the ROM summary if big libraries crawl.
  for (const id of [...batch.filter((i) => ids.includes(i)), ...ids.filter((i) => !batch.includes(i))]) {
    const rom = await getRom(id);
    if (rom && crc32(rom.data) === crc) return id;
  }
}

/** Apply a patch to the library game `baseId` and store the result as its own game, linked to it (`force`: a second copy). */
async function applyTo(r: ImportRow, p: Uint8Array, baseId: string, force = false): Promise<Partial<ImportRow>> {
  const rom = await getRom(baseId);
  if (!rom) return { st: 'bad' };
  let res;
  try { res = applyPatch(rom.data, p); } catch (e) {
    if (e instanceof PatchError) return { st: 'bad', note: t(e.reason === 'source' ? 'add.patch.wrongBase' : 'add.patch.broken') };
    throw e;
  }
  const o = asRow(await importRom(r.name.replace(/\.[^.]+$/, '.gb'), res.data, force, undefined, { sha1: await computeSha1(rom.data), patch: r.name }));
  return { ...o, base: baseId, note: res.verified || o.st === 'bad' ? undefined : t('add.patch.unverified') };
}

/** A waiting patch applied to the library game the player chose (still verified: a BPS/UPS for another game is refused). */
export async function applyToBase(r: ImportRow, baseId: string) {
  patchRow(r.key, { st: 'work' }, true);
  const p = await r.read?.().catch(() => null);
  if (!p) { patchRow(r.key, { st: 'base' }, true); toast(t('add.toast.reread'), 'm'); return; }
  try {
    const out = await applyTo(r, p, baseId);
    patchRow(r.key, out, true);
    if (out.st === 'ok' || out.st === 'unk') toast(t('add.toast.added', { count: 1 }), 'c');
  } catch (e) {
    patchRow(r.key, { st: 'base' }, true);
    await storageFull(e);
  }
}

/** Stop: what is being stored finishes, nothing after it starts. */
export function cancelImport() {
  gen++;
  flush();
  stopWaiting();
}

async function storageFull(e: unknown) {
  const est = await navigator.storage?.estimate?.().catch(() => undefined);
  cancelImport();
  const other = !(e instanceof DOMException && e.name === 'QuotaExceededError');
  useImports.setState({ full: { usage: est?.usage ?? 0, quota: est?.quota ?? 0, other } });
}

/** A duplicate stored again as a second copy. */
export async function importAnyway(r: ImportRow) {
  if (!r.read) return;
  patchRow(r.key, { st: 'work' }, true);
  const data = await r.read().catch(() => null);
  if (!data) { patchRow(r.key, { st: 'dup' }, true); toast(t('add.toast.reread'), 'm'); return; }
  try {
    patchRow(r.key, r.patch && r.base ? await applyTo(r, data, r.base, true) : asRow(await importRom(r.name, data, true)), true);
    toast(t('add.toast.copy'), 'c');
  } catch (e) {
    patchRow(r.key, { st: 'dup' }, true);
    await storageFull(e);
  }
}
