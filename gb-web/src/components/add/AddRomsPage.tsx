import { memo, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { renameGame, useGameLibrary } from '../../hooks/useGameLibrary';
import { cancelImport, importAnyway, patchRow, queueImport, useImports, type Full, type ImportRow, type RowState } from '../../lib/import-queue';
import { fileAccept, useInstall } from '../../lib/pwa';
import { paths } from '../../lib/ui';
import type { GameEntry } from '../../types/game';
import { I } from '../icons';
import { Cover } from '../library/Cover';
import { StorageNotice } from '../library/LibraryPage';
import { startInstall, toast } from '../shell/actions';

const LABEL: Record<RowState, string> = { work: 'Checking…', ok: 'Added', dup: 'Already in library', unk: 'Added, not recognized', bad: 'Skipped', stop: 'Not imported' };
const size = (n: number) => (n > 1e9 ? `${(n / 2 ** 30).toFixed(1)} GB` : n > 1e6 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const num = (n: number) => n.toLocaleString('en-US');

export function AddRomsPage() {
  const { games, storageError } = useGameLibrary();
  const { rows, ignored, full } = useImports();
  const byId = useMemo(() => new Map(games.map((g) => [g.id, g])), [games]);
  const [over, setOver] = useState(false);
  const [renaming, setRenaming] = useState<ImportRow | null>(null);

  useEffect(() => { document.title = 'Add ROMs · Cartouche'; }, []);

  const rename = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const title = String(new FormData(e.currentTarget).get('t') ?? '').trim();
    if (!renaming?.id || !title) return;
    await renameGame(renaming.id, title);
    patchRow(renaming.key, { title }, true);
    setRenaming(null);
    toast('Renamed', 'c');
  };

  const count = (...st: RowState[]) => rows.reduce((n, r) => n + +st.includes(r.st), 0);
  const left = count('work');
  const done = rows.length - left;

  return (
    <main className="wrap">
      <div className="pagehead">
        <h1>Add ROMs</h1>
        <p>Drop your .gb and .gbc files, or a .zip of them. Each one is identified by its SHA-1 fingerprint against the known dumps, so it arrives with its details. Files never leave this browser.</p>
      </div>
      {storageError && <StorageNotice />}
      <div className={`drop${over ? ' over' : ''}`} hidden={storageError}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={() => setOver(false)}>
        <div className="ic">{I.cart}</div>
        <div><h2>Drop files here</h2><p>Several at once, or a whole .zip. Duplicates are caught before they’re stored.</p></div>
        <div className="acts">
          <label className="btn y" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.querySelector('input')?.click(); } }}>
            {I.plus}Choose files
            <input type="file" multiple accept={fileAccept('.gb,.gbc,.rom,.bin,.zip')} className="sr" tabIndex={-1}
              onChange={(e) => { queueImport([...(e.target.files ?? [])]); e.target.value = ''; }} />
          </label>
        </div>
      </div>
      <p className="tip" hidden={storageError}>
        <b>From your iPhone</b> Put your ROMs in a folder in iCloud Drive. In the Files app, long-press the folder and choose Compress, then choose that .zip here. Selecting several files works too.
      </p>

      {full && <FullNotice {...full} />}

      {rows.length > 0 && (
        <section className="results" aria-labelledby="h-import">
          <div className="sec-h" style={{ marginBottom: 0 }}>
            <h2 id="h-import">This import</h2>
            <span className="count">{num(done)} of {num(rows.length)} checked</span>
            {left > 0 && <button className="btn line end" style={{ height: 38, alignSelf: 'center' }} onClick={cancelImport}>Stop</button>}
          </div>
          <div className="progress" role="progressbar" aria-label="Import progress" aria-valuemin={0} aria-valuemax={rows.length} aria-valuenow={done}>
            <i style={{ width: `${(done / rows.length) * 100}%` }} />
          </div>
          <div>
            {rows.map((r) => <Row key={r.key} r={r} g={r.id ? byId.get(r.id) : undefined} onRename={setRenaming} />)}
          </div>
          {left === 0 && (
            <div className="sumline">
              <span><b>{num(count('ok', 'unk'))}</b> added</span><span><b>{num(count('dup'))}</b> duplicate</span><span><b>{num(count('bad'))}</b> skipped</span>
              {count('stop') > 0 && <span><b>{num(count('stop'))}</b> not imported</span>}
              {ignored > 0 && <span title="Folders and system files such as __MACOSX and .DS_Store"><b>{num(ignored)}</b> system files ignored</span>}
              <Link className="btn y" to="/" style={{ marginLeft: 'auto' }}>Go to library</Link>
            </div>
          )}
        </section>
      )}
      <RenameDialog row={renaming} onClose={() => setRenaming(null)} onSubmit={rename} />
    </main>
  );
}

/** One file of the import. Memoized: a big import re-renders only the rows that changed. */
const Row = memo(function Row({ r, g, onRename }: { r: ImportRow; g?: GameEntry; onRename: (r: ImportRow) => void }) {
  return (
    <div className="rrow">
      {g ? <Cover game={g} /> : <div className="noart"><b>?</b></div>}
      <div className="t">{r.title || g?.title || r.name}
        <small>{r.from && <span className="from">{r.from} › </span>}{r.name} · {size(r.size)}{r.sha1 ? ` · SHA-1 ${r.sha1.slice(0, 8)}…` : ''}{r.st === 'bad' ? ` · ${r.note ?? 'damaged or not a Game Boy ROM'}` : ''}</small>
      </div>
      <span className={`st ${r.st}`}><i />{LABEL[r.st]}</span>
      <span className="act">
        {(r.st === 'ok' || r.st === 'unk') && r.id && <Link className="btn line" style={{ height: 38 }} to={paths.game(r.id)}>Open</Link>}
        {r.st === 'dup' && <button className="btn line" style={{ height: 38 }} onClick={() => importAnyway(r)}>Import anyway</button>}
        {r.st === 'unk' && <button className="btn line" style={{ height: 38 }} onClick={() => onRename(r)}>Rename</button>}
      </span>
    </div>
  );
});

/** The disk (or the browser's share of it) is full: the import stopped between two ROMs, nothing half-stored. */
function FullNotice({ usage, quota, other }: Full) {
  const canInstall = useInstall((s) => s.can) !== null;
  const canKeep = typeof navigator.storage?.persist === 'function';
  const keep = async () => {
    const ok = await navigator.storage.persist().catch(() => false);
    toast(ok ? 'Storage kept: the browser won’t clear it' : 'The browser didn’t allow it', ok ? 'c' : 'm');
  };
  return (
    <section className="fullnote paper" role="alert" aria-labelledby="h-full">
      <h2 id="h-full">{other ? 'Couldn’t save to this browser’s storage' : 'Storage is full'}</h2>
      <p>
        The import stopped. Every ROM added before that is safe; the rest wasn’t imported.
        {quota > 0 && usage / quota > 0.9 && ` Cartouche is using ${size(usage)} of the ${size(quota)} this browser allows it.`}
      </p>
      <p>Free up space on this device{canInstall ? ', install the app' : ''} and keep its storage, then add the same files again: the ones already in your library are skipped as duplicates.</p>
      <div className="acts">
        {canInstall && <button className="btn k" onClick={startInstall}>{I.load}Install the app</button>}
        {canKeep && <button className="btn line" onClick={keep}>Keep storage</button>}
      </div>
    </section>
  );
}

function RenameDialog({ row, onClose, onSubmit }: { row: ImportRow | null; onClose: () => void; onSubmit: (e: FormEvent<HTMLFormElement>) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (row && d && !d.open) d.showModal();
    if (!row && d?.open) d.close();
  }, [row]);
  return (
    <dialog ref={ref} className="mdlg" aria-labelledby="h-rename" onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      {row && (
        <form className="in" onSubmit={onSubmit}>
          <h2 id="h-rename">Name this ROM</h2>
          <p>It wasn’t recognized, so it has no box art. Give it a title for your shelf.</p>
          <input className="field" name="t" style={{ width: '100%', marginBottom: 18 }} aria-label="Title" autoFocus
            defaultValue={row.title || row.name.replace(/\.[^.]+$/, '')} />
          <div className="acts">
            <button type="button" className="btn line" onClick={onClose}>Cancel</button>
            <button className="btn k">Save</button>
          </div>
        </form>
      )}
    </dialog>
  );
}
