import { create } from 'zustand';
import { importRom, isRomFile, MAX_ROM_SIZE, type ImportOutcome, type ImportStatus } from '../hooks/useGameLibrary';
import { toast } from '../components/shell/actions';
import { listZip, readEntry, ZipError } from './zip';
import { t } from '../i18n';

/**
 * The import queue: files dropped anywhere in the app or chosen on the Add ROMs page, and the ROMs inside
 * .zip archives, checked and stored one at a time. It lives outside the page, so an import keeps going
 * (and the header shows its progress) while the player browses the library.
 */
export type RowState = ImportStatus | 'work' | 'stop';
export interface ImportRow {
  key: string; name: string; size: number; st: RowState;
  /** The archive it comes from. */
  from?: string;
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
const HIDDEN = /(^|\/)(__MACOSX\/|\.)/;
let seq = 0;

async function expand(files: File[]): Promise<{ rows: ImportRow[]; ignored: number }> {
  const rows: ImportRow[] = [];
  let ignored = 0;
  for (const f of files) {
    if (!/\.zip$/i.test(f.name)) {
      rows.push({ key: String(++seq), name: f.name, size: f.size, st: 'work', read: async () => new Uint8Array(await f.arrayBuffer()) });
      continue;
    }
    try {
      for (const e of await listZip(f)) {
        if (e.name.endsWith('/') || HIDDEN.test(e.name)) { ignored++; continue; }
        rows.push({ key: String(++seq), name: e.name.split('/').pop()!, size: e.size, from: f.name, st: 'work', read: () => readEntry(f, e) });
      }
    } catch (err) {
      rows.push({ key: String(++seq), name: f.name, size: f.size, st: 'bad', note: err instanceof ZipError ? err.message : t('add.unreadable') });
    }
  }
  return { rows, ignored };
}

/** Bumped by Stop (and by a full disk): everything queued before it stops. */
let gen = 0;
let chain = Promise.resolve();
let queued = 0;
/** The row being stored right now: Stop lets it finish. */
let current: string | null = null;
const stopWaiting = () => useImports.setState((s) => ({ rows: s.rows.map((r) => (r.st === 'work' && r.key !== current ? { ...r, st: 'stop' } : r)) }));

export function queueImport(files: File[]) {
  if (!files.length) return;
  const my = gen;
  // Dropped while another import runs: its rows join the list instead of replacing it.
  const append = queued > 0;
  queued++;
  chain = chain.then(async () => {
    if (my !== gen) return;
    const { rows: fresh, ignored } = await expand(files);
    flush();
    useImports.setState((s) => (append
      ? { rows: [...s.rows, ...fresh], ignored: s.ignored + ignored }
      : { rows: fresh, ignored, full: null }));
    let added = 0;
    for (const r of fresh) {
      if (my !== gen) break;
      if (r.st !== 'work') continue;
      current = r.key;
      let out: Partial<ImportRow>;
      let data: Uint8Array | undefined;
      try {
        if (isRomFile(r.name) && r.size <= MAX_ROM_SIZE) data = await r.read!();
        out = { st: 'bad' };
      } catch (e) {
        out = { st: 'bad', note: e instanceof ZipError ? e.message.toLowerCase() : t('add.unreadable') };
      }
      if (data) {
        // A file that was read but couldn't be stored: the storage is failing, so every next ROM would too.
        try { out = asRow(await importRom(r.name, data)); } catch (e) { await storageFull(e); break; }
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
    patchRow(r.key, asRow(await importRom(r.name, data, true)), true);
    toast(t('add.toast.copy'), 'c');
  } catch (e) {
    patchRow(r.key, { st: 'dup' }, true);
    await storageFull(e);
  }
}
