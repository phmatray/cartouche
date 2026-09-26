import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { importFile, renameGame, useGameLibrary, type ImportStatus } from '../../hooks/useGameLibrary';
import { paths } from '../../lib/ui';
import { I } from '../icons';
import { Cover } from '../library/Cover';
import { StorageNotice } from '../library/LibraryPage';
import { queueImport, toast, usePendingImport } from '../shell/actions';

type St = ImportStatus | 'work';
interface Row { key: string; file: File; st: St; id?: string; title?: string; sha1?: string }

const LABEL: Record<St, string> = { work: 'Checking…', ok: 'Added', dup: 'Already in library', unk: 'Added, not recognized', bad: 'Skipped' };
const size = (n: number) => (n > 1e6 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
let seq = 0;

export function AddRomsPage() {
  const { games, storageError } = useGameLibrary();
  const [rows, setRows] = useState<Row[]>([]);
  const [over, setOver] = useState(false);
  const [renaming, setRenaming] = useState<Row | null>(null);
  const chain = useRef(Promise.resolve());
  const patch = useCallback((key: string, p: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r))), []);

  useEffect(() => { document.title = 'Add ROMs · Cartouche'; }, []);

  // Files come from the drop zone, the file picker or a drop anywhere else in the app, through one queue.
  const run = useCallback((files: File[]) => {
    const fresh: Row[] = files.map((file) => ({ key: String(++seq), file, st: 'work' }));
    setRows((rs) => (rs.some((r) => r.st === 'work') ? [...rs, ...fresh] : fresh));
    chain.current = chain.current.then(async () => {
      let added = 0;
      for (const r of fresh) {
        const out = await importFile(r.file).catch(() => ({ status: 'bad' as const }));
        if (out.status === 'ok' || out.status === 'unk') added++;
        patch(r.key, { st: out.status, ...out });
      }
      if (added) toast(`${added} ROM${added > 1 ? 's' : ''} added to your library`, 'c');
    });
  }, [patch]);
  // Drain the queue: what was dropped before this page opened, then every later drop, as it arrives.
  useEffect(() => {
    const take = ({ files }: { files: File[] }) => {
      if (!files.length) return;
      usePendingImport.setState({ files: [] });
      run(files);
    };
    take(usePendingImport.getState());
    return usePendingImport.subscribe(take);
  }, [run]);

  const force = async (r: Row) => {
    patch(r.key, { st: 'work' });
    const out = await importFile(r.file, true);
    patch(r.key, { st: out.status, ...out });
    toast('Imported as a second copy', 'c');
  };
  const rename = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const title = String(new FormData(e.currentTarget).get('t') ?? '').trim();
    if (!renaming?.id || !title) return;
    await renameGame(renaming.id, title);
    patch(renaming.key, { title });
    setRenaming(null);
    toast('Renamed', 'c');
  };

  const done = rows.filter((r) => r.st !== 'work').length;
  const count = (...st: St[]) => rows.filter((r) => st.includes(r.st)).length;

  return (
    <main className="wrap">
      <div className="pagehead">
        <h1>Add ROMs</h1>
        <p>Drop your .gb and .gbc files. Each one is identified by its SHA-1 fingerprint against the known dumps, so it arrives with its details. Files never leave this browser.</p>
      </div>
      {storageError && <StorageNotice />}
      <div className={`drop${over ? ' over' : ''}`} hidden={storageError}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={() => setOver(false)}>
        <div className="ic">{I.cart}</div>
        <div><h2>Drop files here</h2><p>Several at once is fine. Duplicates are caught before they’re stored.</p></div>
        <div className="acts">
          <label className="btn y" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.querySelector('input')?.click(); } }}>
            {I.plus}Choose files
            <input type="file" multiple accept=".gb,.gbc,.rom,.bin" className="sr" tabIndex={-1}
              onChange={(e) => { queueImport([...(e.target.files ?? [])]); e.target.value = ''; }} />
          </label>
        </div>
      </div>

      {rows.length > 0 && (
        <section className="results" aria-labelledby="h-import">
          <div className="sec-h" style={{ marginBottom: 0 }}><h2 id="h-import">This import</h2><span className="count">{done} of {rows.length} checked</span></div>
          <div className="progress" role="progressbar" aria-label="Import progress" aria-valuemin={0} aria-valuemax={rows.length} aria-valuenow={done}>
            <i style={{ width: `${(done / rows.length) * 100}%` }} />
          </div>
          <div>
            {rows.map((r) => {
              const g = r.id ? games.find((x) => x.id === r.id) : undefined;
              return (
                <div className="rrow" key={r.key}>
                  {g ? <Cover game={g} /> : <div className="noart"><b>?</b></div>}
                  <div className="t">{r.title || g?.title || r.file.name}
                    <small>{r.file.name} · {size(r.file.size)}{r.sha1 ? ` · SHA-1 ${r.sha1.slice(0, 8)}…` : ''}{r.st === 'bad' ? ' · damaged or not a Game Boy ROM' : ''}</small>
                  </div>
                  <span className={`st ${r.st}`}><i />{LABEL[r.st]}</span>
                  <span className="act">
                    {(r.st === 'ok' || r.st === 'unk') && r.id && <Link className="btn line" style={{ height: 38 }} to={paths.game(r.id)}>Open</Link>}
                    {r.st === 'dup' && <button className="btn line" style={{ height: 38 }} onClick={() => force(r)}>Import anyway</button>}
                    {r.st === 'unk' && <button className="btn line" style={{ height: 38, marginLeft: 8 }} onClick={() => setRenaming(r)}>Rename</button>}
                  </span>
                </div>
              );
            })}
          </div>
          {done === rows.length && (
            <div className="sumline">
              <span><b>{count('ok', 'unk')}</b> added</span><span><b>{count('dup')}</b> duplicate</span><span><b>{count('bad')}</b> skipped</span>
              <Link className="btn y" to="/" style={{ marginLeft: 'auto' }}>Go to library</Link>
            </div>
          )}
        </section>
      )}
      <RenameDialog row={renaming} onClose={() => setRenaming(null)} onSubmit={rename} />
    </main>
  );
}

function RenameDialog({ row, onClose, onSubmit }: { row: Row | null; onClose: () => void; onSubmit: (e: FormEvent<HTMLFormElement>) => void }) {
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
            defaultValue={row.title || row.file.name.replace(/\.[^.]+$/, '')} />
          <div className="acts">
            <button type="button" className="btn line" onClick={onClose}>Cancel</button>
            <button className="btn k">Save</button>
          </div>
        </form>
      )}
    </dialog>
  );
}
