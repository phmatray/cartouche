import { memo, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { renameGame, useGameLibrary } from '../../hooks/useGameLibrary';
import { applyToBase, cancelImport, importAnyway, patchRow, queueImport, useImports, type Full, type ImportRow, type RowState } from '../../lib/import-queue';
import { fileAccept, useInstall } from '../../lib/pwa';
import { paths, touchOnly } from '../../lib/ui';
import type { GameEntry } from '../../types/game';
import { I } from '../icons';
import { Cover } from '../library/Cover';
import { StorageNotice } from '../library/LibraryPage';
import { startInstall, toast } from '../shell/actions';
import { FileButton } from '../shell/FileButton';
import { rich, size, t as tNow, useT, type Key } from '../../i18n';

const LABEL: Record<RowState, Key> = { work: 'add.st.work', ok: 'add.st.ok', dup: 'add.st.dup', unk: 'add.st.unk', bad: 'add.st.bad', stop: 'add.st.stop', base: 'add.st.base' };

export function AddRomsPage() {
  const { games, storageError } = useGameLibrary();
  const { rows, ignored, full } = useImports();
  const byId = useMemo(() => new Map(games.map((g) => [g.id, g])), [games]);
  const [over, setOver] = useState(false);
  const [renaming, setRenaming] = useState<ImportRow | null>(null);
  const [picking, setPicking] = useState<ImportRow | null>(null);
  const t = useT();

  useEffect(() => { document.title = t('common.docTitle', { page: t('shell.addRoms') }); }, [t]);

  const rename = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const title = String(new FormData(e.currentTarget).get('t') ?? '').trim();
    if (!renaming?.id || !title) return;
    await renameGame(renaming.id, title);
    patchRow(renaming.key, { title }, true);
    setRenaming(null);
    toast(tNow('add.renamed'), 'c');
  };

  const count = (...st: RowState[]) => rows.reduce((n, r) => n + +st.includes(r.st), 0);
  const left = count('work');
  const done = rows.length - left;

  return (
    <main className="wrap">
      <div className="pagehead">
        <h1>{t('shell.addRoms')}</h1>
        <p>{t('add.intro')}</p>
      </div>
      {storageError && <StorageNotice />}
      <div className={`drop${over ? ' over' : ''}`} hidden={storageError}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={() => setOver(false)}>
        <div className="ic">{I.cart}</div>
        <div><h2>{t('add.drop')}</h2><p>{t('add.dropSub')}</p></div>
        <div className="acts">
          <FileButton className="btn y" multiple accept={fileAccept('.gb,.gbc,.rom,.bin,.zip,.ips,.bps,.ups')} onFiles={queueImport}>{I.plus}{t('add.choose')}</FileButton>
        </div>
      </div>
      {/* How to get files onto a phone: only on one (a desktop has a file manager and drag and drop). */}
      <p className="tip" hidden={storageError || !touchOnly()}>
        {rich(t('add.iphone'), { b: (s) => <b>{s}</b> })}
      </p>

      {full && <FullNotice {...full} />}

      {rows.length > 0 && (
        <section className="results" aria-labelledby="h-import">
          <div className="sec-h" style={{ marginBottom: 0 }}>
            <h2 id="h-import">{t('add.import')}</h2>
            <span className="count">{t('add.checked', { done, total: rows.length })}</span>
            {left > 0 && <button className="btn line end" style={{ height: 38, alignSelf: 'center' }} onClick={cancelImport}>{t('add.stop')}</button>}
          </div>
          <div className="progress" role="progressbar" aria-label={t('add.progress')} aria-valuemin={0} aria-valuemax={rows.length} aria-valuenow={done}>
            <i style={{ transform: `scaleX(${done / rows.length})` }} />
          </div>
          <div>
            {rows.map((r) => <Row key={r.key} r={r} g={r.id ? byId.get(r.id) : undefined} onRename={setRenaming} onPick={setPicking} />)}
          </div>
          {left === 0 && (
            <div className="sumline">
              {(['added', 'dup', 'bad'] as const).map((k) => { const n = k === 'added' ? count('ok', 'unk') : count(k); return <span key={k}>{rich(t(`add.sum.${k}`, { count: n }), { b: (s) => <b>{s}</b> })}</span>; })}
              {count('stop') > 0 && <span>{rich(t('add.sum.stop', { count: count('stop') }), { b: (s) => <b>{s}</b> })}</span>}
              {ignored > 0 && <span title={t('add.sum.ignoredTitle')}>{rich(t('add.sum.ignored', { count: ignored }), { b: (s) => <b>{s}</b> })}</span>}
              <Link className="btn y" to="/" style={{ marginLeft: 'auto' }}>{t('add.goLibrary')}</Link>
            </div>
          )}
        </section>
      )}
      <RenameDialog row={renaming} onClose={() => setRenaming(null)} onSubmit={rename} />
      <BaseDialog row={picking} games={games} onClose={() => setPicking(null)} />
    </main>
  );
}

/** One file of the import. Memoized: a big import re-renders only the rows that changed. */
const Row = memo(function Row({ r, g, onRename, onPick }: { r: ImportRow; g?: GameEntry; onRename: (r: ImportRow) => void; onPick: (r: ImportRow) => void }) {
  const t = useT();
  return (
    <div className="rrow">
      {g ? <Cover game={g} /> : <div className="noart"><b>?</b></div>}
      <div className="t">{r.title || g?.title || r.name}
        <small>{r.from && <span className="from">{r.from} › </span>}{r.name} · {size(r.size)}{r.sha1 ? ` · SHA-1 ${r.sha1.slice(0, 8)}…` : ''}{r.st === 'bad' ? ` · ${r.note ?? t('add.notRom')}` : r.note ? ` · ${r.note}` : ''}</small>
      </div>
      <span className={`st ${r.st}`}><i />{t(LABEL[r.st])}</span>
      <span className="act">
        {(r.st === 'ok' || r.st === 'unk') && r.id && <Link className="btn line" style={{ height: 38 }} to={paths.game(r.id)}>{t('common.open')}</Link>}
        {r.st === 'dup' && <button className="btn line" style={{ height: 38 }} onClick={() => importAnyway(r)}>{t('add.anyway')}</button>}
        {r.st === 'unk' && <button className="btn line" style={{ height: 38 }} onClick={() => onRename(r)}>{t('common.rename')}</button>}
        {r.st === 'base' && <button className="btn line" style={{ height: 38 }} onClick={() => onPick(r)}>{t('add.patch.chooseBase')}</button>}
      </span>
    </div>
  );
});

/** The disk (or the browser's share of it) is full: the import stopped between two ROMs, nothing half-stored. */
function FullNotice({ usage, quota, other }: Full) {
  const canInstall = useInstall((s) => s.can) !== null;
  const canKeep = typeof navigator.storage?.persist === 'function';
  const t = useT();
  const keep = async () => {
    const ok = await navigator.storage.persist().catch(() => false);
    toast(ok ? tNow('add.full.kept') : tNow('add.full.refused'), ok ? 'c' : 'm');
  };
  return (
    <section className="fullnote paper" role="alert" aria-labelledby="h-full">
      <h2 id="h-full">{other ? t('add.full.other') : t('add.full.title')}</h2>
      <p>
        {t('add.full.stopped')}
        {quota > 0 && usage / quota > 0.9 && ` ${t('add.full.using', { usage: size(usage), quota: size(quota) })}`}
      </p>
      <p>{canInstall ? t('add.full.freeInstall') : t('add.full.free')}</p>
      <div className="acts">
        {canInstall && <button className="btn k" onClick={startInstall}>{I.load}{t('common.install')}</button>}
        {canKeep && <button className="btn line" onClick={keep}>{t('add.full.keep')}</button>}
      </div>
    </section>
  );
}

function RenameDialog({ row, onClose, onSubmit }: { row: ImportRow | null; onClose: () => void; onSubmit: (e: FormEvent<HTMLFormElement>) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const t = useT();
  useEffect(() => {
    const d = ref.current;
    if (row && d && !d.open) d.showModal();
    if (!row && d?.open) d.close();
  }, [row]);
  return (
    <dialog ref={ref} className="mdlg" aria-labelledby="h-rename" onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      {row && (
        <form className="in" onSubmit={onSubmit}>
          <h2 id="h-rename">{t('add.rename.title')}</h2>
          <p>{t('add.rename.body')}</p>
          <input className="field" name="t" style={{ width: '100%', marginBottom: 18 }} aria-label={t('library.col.title')} autoFocus
            defaultValue={row.title || row.name.replace(/\.[^.]+$/, '')} />
          <div className="acts">
            <button type="button" className="btn line" onClick={onClose}>{t('common.cancel')}</button>
            <button className="btn k">{t('common.save')}</button>
          </div>
        </form>
      )}
    </dialog>
  );
}

/** A patch waiting for its base: the games stored in this browser, by title. */
function BaseDialog({ row, games, onClose }: { row: ImportRow | null; games: GameEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const t = useT();
  const local = useMemo(() => games.filter((g) => g.isLocal).sort((a, b) => a.title.localeCompare(b.title)), [games]);
  useEffect(() => {
    const d = ref.current;
    if (row && d && !d.open) d.showModal();
    if (!row && d?.open) d.close();
  }, [row]);
  return (
    <dialog ref={ref} className="mdlg" aria-labelledby="h-base" onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      {row && (
        <div className="in">
          <h2 id="h-base">{t('add.patch.chooseBase')}</h2>
          <p>{local.length ? t('add.patch.pickBody') : t('add.patch.none')}</p>
          <div style={{ maxHeight: '50vh', overflowY: 'auto', marginBottom: 18 }}>
            {local.map((g) => (
              <button key={g.id} type="button" className="btn line" style={{ width: '100%', justifyContent: 'flex-start', marginBottom: 6 }}
                onClick={() => { onClose(); applyToBase(row, g.id); }}>{g.title}</button>
            ))}
          </div>
          <div className="acts">
            <button type="button" className="btn line" onClick={onClose}>{t('common.cancel')}</button>
          </div>
        </div>
      )}
    </dialog>
  );
}
