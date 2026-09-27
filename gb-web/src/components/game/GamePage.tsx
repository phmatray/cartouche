import { lazy, Suspense, useCallback, useEffect, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { GameEntry } from '../../types/game';
import { downloadGame, FetchError, refreshSavedIds, useGameLibrary } from '../../hooks/useGameLibrary';
import { createProfile, deleteSave, getActiveProfileId, getGameSaveStates, getSram, listProfiles, saveSram, setActiveProfile, uniqueName, type StoredSave, type StoredSaveState } from '../../lib/db';
import { mapperSupported, type RomMetadata } from '../../lib/rom-utils';
import { ago, assetUrl, bytes, download, dur, owned, paths, tagOf, touchOnly } from '../../lib/ui';
import { I } from '../icons';
import { Cover, Title } from '../library/Cover';
import { Frame } from '../library/Heroes';
import { useInk } from '../../hooks/useInk';
import { NotFound } from '../shell/AppShell';
import { toast } from '../shell/actions';
import { ConfirmDialog, type ConfirmRequest } from '../shell/ConfirmDialog';
import { hardwareOf, importSav, useAlbum, useLinkRom, useRomHeader } from '../../hooks/useGameExtras';
import { Shot } from './Shot';
import { TagLinks } from '../library/TagLinks';
import { genreLabel } from '../../lib/search';
import { fileAccept } from '../../lib/pwa';
import { creditOf, descOf } from '../../lib/catalog-utils';
import { headerSize, rich, size, t as tNow, useT } from '../../i18n';
import { raShown } from '../../lib/retroachievements';

const Achievements = lazy(() => import('./Achievements'));

export function GamePage() {
  const { id = '' } = useParams<{ id: string }>();
  const { getGameById, loading } = useGameLibrary();
  const game = getGameById(id);
  if (loading) return <main className="gp" aria-busy="true" />;
  if (!game) return <NotFound />;
  return <GameDetails key={game.id} game={game} />;
}

const btnSm: CSSProperties = { height: 36, padding: '0 12px', fontSize: 13 };

function GameDetails({ game }: { game: GameEntry }) {
  const { savedIds, toggleFavorite, deleteGame, eraseSaves } = useGameLibrary();
  const navigate = useNavigate();
  const t = useT();
  const ink = useInk(game);
  const header = useRomHeader(game);
  const { shots } = useAlbum(game.id);
  const linkRom = useLinkRom(game);
  const [states, setStates] = useState<(StoredSaveState | undefined)[]>([]);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [profiles, setProfiles] = useState<StoredSave[]>([]);
  const [kind, label] = tagOf(game, savedIds);
  const need = !owned(game);
  const unsupported = !!header && !mapperSupported(header);
  /** GB Studio collection: a hosted game not downloaded yet, or one its author distributes (link-out). */
  const hosted = !!game.madeWith && !!game.romUrl && !game.isLocal;
  const author = !!game.madeWith && need && !!game.homepage;
  const auto = states[0];
  const slots = Array.from({ length: 5 }, (_, i) => states[i + 1]);

  useEffect(() => { document.title = t('common.docTitle', { page: game.title }); }, [game.title, t]);
  useEffect(() => {
    let cancelled = false;
    getGameSaveStates(game.id).then((s) => { if (!cancelled) setStates(s); }).catch(() => {});
    listProfiles(game.id).then((p) => { if (!cancelled) setProfiles(p); }).catch(() => {});
    return () => { cancelled = true; };
  }, [game.id, savedIds]);
  const profileName = (id?: string) => (profiles.length > 1 && id ? profiles.find((p) => p.id === id)?.name : undefined);

  const remove = () => setConfirm(game.isLocal ? {
    title: t('game.remove.title'), danger: true, ok: t('game.remove.ok'),
    body: t('game.remove.body', { title: game.title }),
    run: async () => { await deleteGame(game.id); toast(tNow('game.removed', { title: game.title }), 'm'); navigate('/'); },
  } : {
    title: t('game.erase.title'), danger: true, ok: t('game.erase.ok'),
    body: t('game.erase.body', { title: game.title }),
    run: async () => { await eraseSaves(game.id); toast(tNow('game.erased'), 'm'); },
  });

  return (
    <main className="gp" style={{ '--flood': ink } as CSSProperties}>
      <section className="flood">
        <div className="wrap hero">
          <div className="box"><Cover game={game} className="boxart" /></div>
          <div className="info">
            <nav className="crumbs" aria-label={t('game.crumbs')}><Link to="/">{t('shell.nav.library')}</Link>{I.next}<span>{genreLabel(game) || t('game.game')}</span></nav>
            <h1 className="hero-t"><Title text={game.title} /></h1>
            <div className="facts"><TagLinks game={game} keys={['year', 'developer', 'publisher', 'genre', 'players', 'region', 'platform', 'made', 'is']} className="fact" /></div>
            <div className="acts">
              {author && <a className="btn lg play" href={game.homepage} target="_blank" rel="noreferrer">{I.ext}{t('game.author.get')}</a>}
              {need ? (
                <label className={`btn lg ${author ? 'line' : 'play'}`} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.querySelector('input')?.click(); } }}>
                  {I.cart}{t('game.loadRom')}
                  <input type="file" accept={fileAccept('.gb,.gbc,.zip')} className="sr" tabIndex={-1}
                    onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f && await linkRom(f)) navigate(paths.play(game.id)); }} />
                </label>
              ) : unsupported ? (
                <button className="btn lg play" disabled>{I.play}{t('game.unsupported')}</button>
              ) : (
                <Link className="btn lg play" to={paths.play(game.id, auto ? '?resume=1' : '')}>{I.play}{auto ? t('library.hero.continue') : t('library.hero.play')}</Link>
              )}
              {hosted && <Download game={game} />}
              <button className="btn lg line" aria-pressed={!!game.isFavorite} onClick={() => toggleFavorite(game.id)}>
                {game.isFavorite ? <>{I.star}{t('library.favorite')}</> : <>{I.starO}{t('game.addFav')}</>}
              </button>
              {!need && (game.players ?? 1) > 1 && <Link className="btn lg line" to={`/link-cable?g=${encodeURIComponent(game.id)}`}>{I.link}{t('game.linkCable')}</Link>}
            </div>
          </div>
        </div>
      </section>

      <div className="wrap body">
        <article className="paper sheet-card">
          <h2>{t('game.about')}</h2>
          {descOf(game) && <p className="lede">{descOf(game)}</p>}
          {hosted && game.size && <p className="lede" style={{ fontSize: 15 }}>{t('game.dl.note', { size: size(game.size) })}</p>}
          {unsupported && <p className="lede" style={{ fontSize: 15 }}>{t('game.unsupportedBody', { mapper: header.cartridgeType })}</p>}
          {need && <p className="lede" style={{ fontSize: 15 }}>{game.homepage ? rich(t('game.getIt'), { a: (s) => <a href={game.homepage} target="_blank" rel="noreferrer">{s}</a> }) : t('game.loadIt')}</p>}
          {game.license && (
            <>
              <h3>{t('game.credits')}</h3>
              <p className="credit">
                {game.copyright && <>{game.copyright}. </>}
                {creditOf(game, 'license')}{game.licenseUrl && <> (<a href={assetUrl(game.licenseUrl)} target="_blank" rel="noreferrer">{t('game.license')}</a>)</>}.
                {game.source && <> {t('game.source')} <a href={game.source} target="_blank" rel="noreferrer">{game.source.replace(/^https?:\/\//, '')}</a>.</>}
                {game.homepage && <> {t('game.homepage')} <a href={game.homepage} target="_blank" rel="noreferrer">{game.homepage.replace(/^https?:\/\//, '')}</a>.</>}
                {game.changes && <> {creditOf(game, 'changes')}</>}
                {game.coverCredit && <> {creditOf(game, 'coverCredit')}</>}
                {game.romUrl && game.madeWith && <> {t('game.notices')} <a href={assetUrl('roms/gbstudio/LICENSES.txt')} target="_blank" rel="noreferrer">LICENSES.txt</a>.</>}
                {game.romUrl && !game.madeWith && !game.isLocal && <> {t('game.notices')} <a href={assetUrl('THIRD_PARTY_NOTICES.txt')} target="_blank" rel="noreferrer">THIRD_PARTY_NOTICES.txt</a>.</>}
              </p>
            </>
          )}
          <h3>{t('game.cart.title')}</h3>
          {header ? (
            <dl className="spec">
              <div><dt>{t('game.cart.hardware')}</dt><dd>{hardwareOf(header)}</dd></div>
              <div><dt>{t('game.cart.mapper')}</dt><dd>{header.cartridgeType}</dd></div>
              <div><dt>{t('game.cart.romSize')}</dt><dd>{headerSize(header.romSize)}</dd></div>
              <div><dt>{t('game.cart.ram')}</dt><dd>{headerSize(header.ramSize)}</dd></div>
              <div><dt>{t('game.cart.headerTitle')}</dt><dd>{header.title || '—'}</dd></div>
              <div><dt>{t('game.cart.source')}</dt><dd>{game.isLocal ? t('game.cart.yourFile') : game.madeWith ? t('game.cart.hosted') : game.romUrl ? t('game.cart.bundled') : t('game.cart.free')}</dd></div>
              <div><dt>Super Game Boy</dt><dd>{header.sgbFlag !== 'SGB Supported' ? t('game.cart.no') : header.cgbFlag === 'CGB Only' ? t('game.cart.supported') : t('game.cart.sgbPlays')}</dd></div>
              <div><dt>{t('game.cart.revision')}</dt><dd>{header.romVersion ? `1.${header.romVersion}` : '1.0'}</dd></div>
            </dl>
          ) : (
            <div className="empty-inline">{I.cart}<span>{need ? t('game.cart.later') : hosted ? t('game.cart.afterDownload') : t('game.cart.reading')}</span></div>
          )}
          <h3>{t('game.album')}</h3>
          {shots.length ? (
            <div className="album">
              {shots.map((s) => <figure key={s.id}><Shot png={s.png} label={t(s.kind === 'print' ? 'game.print' : 'game.shot', { ago: ago(s.timestamp) })} /><figcaption>{ago(s.timestamp)}</figcaption></figure>)}
            </div>
          ) : (
            <div className="empty-inline">{I.cam}<span>{rich(t(touchOnly() ? 'game.noShotsTouch' : 'game.noShots'), { b: (s) => <b>{s}</b> })}</span></div>
          )}
          {raShown(game) && <Suspense><Achievements game={game} /></Suspense>}
        </article>

        <aside className="side">
          {need ? (
            <section>
              <h3>{t('game.playIt')}</h3>
              <dl className="stats">
                <div><dt>{t('library.col.status')}</dt><dd><span className={`tag ${kind}`} style={{ margin: 0 }}>{label}</span></dd></div>
                {game.price && <div><dt>{t('game.author.price')}</dt><dd>{[t(`game.author.${game.price}`), game.priceNote].filter(Boolean).join(' · ')}</dd></div>}
              </dl>
              <p className="note" style={{ marginTop: 16 }}>{author ? t('game.author.steps') : t('game.dump')}</p>
            </section>
          ) : (
            <>
              <section>
                <h3>{t('game.yourPlay')}</h3>
                <dl className="stats">
                  <div><dt>{t('library.col.played')}</dt><dd>{dur(game.totalPlayTime)}</dd></div>
                  <div><dt>{t('game.sessions')}</dt><dd>{game.sessions ?? 0}</dd></div>
                  <div><dt>{t('library.col.last')}</dt><dd>{game.lastPlayed ? ago(game.lastPlayed) : t('common.never')}</dd></div>
                  <div><dt>{t('library.col.status')}</dt><dd><span className={`tag ${kind}`} style={{ margin: 0 }}>{label}</span></dd></div>
                </dl>
              </section>
              <Saves game={game} header={header} setConfirm={setConfirm} />
              <section>
                <h3>{t('library.hero.slots')}</h3>
                <ul className="minislots">
                  {auto && (
                    <li>
                      <span className="n" style={{ fontSize: 14 }}>{t('game.auto')}</span>
                      <span className="th">{auto.thumbnail.length ? <Frame rgba={auto.thumbnail} label={t('game.resumePoint')} /> : null}</span>
                      <span className="w">{t('game.resumePoint')}<small>{[ago(auto.timestamp), profileName(auto.profile)].filter(Boolean).join(' · ')}</small></span>
                      <Link className="btn line" style={btnSm} to={paths.play(game.id, '?resume=1')}>{t('game.resume')}</Link>
                    </li>
                  )}
                  {slots.map((s, i) => (
                    <li key={i}>
                      <span className="n">{i + 1}</span>
                      <span className="th">{s?.thumbnail.length ? <Frame rgba={s.thumbnail} label={t('game.slot', { n: String(i + 1) })} /> : null}</span>
                      <span className="w">{s ? ago(s.timestamp) : t('common.empty')}{s && profileName(s.profile) && <small>{profileName(s.profile)}</small>}</span>
                      {s ? <Link className="btn line" style={btnSm} to={paths.play(game.id, `?slot=${i}`)}>{t('common.load')}</Link> : <span />}
                    </li>
                  ))}
                </ul>
              </section>
              <section>
                <h3>{t('game.manage')}</h3>
                <div className="danger-zone">
                  <span>{game.isLocal ? (header ? t('game.storedSize', { size: headerSize(header.romSize) }) : t('game.stored')) : (game.madeWith ? t('game.hostedErase') : t('game.bundledErase'))}</span>
                  <button className="btn danger" onClick={remove}>{game.isLocal ? t('game.remove.ok') : t('game.erase.ok')}</button>
                </div>
              </section>
            </>
          )}
        </aside>
      </div>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </main>
  );
}

/**
 * One tap: fetch the hosted ROM, check its SHA-1 and keep it in this browser (it then plays offline).
 * The button fills as the file arrives; a failure says why and the button offers the download again.
 */
function Download({ game }: { game: GameEntry }) {
  const [done, setDone] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const t = useT();
  const go = async () => {
    setErr('');
    setDone(0);
    try {
      await downloadGame(game, setDone);
      toast(tNow('game.dl.done', { title: game.title }), 'c');
    } catch (e) {
      setErr(e instanceof FetchError ? e.message : tNow('game.dl.full')); // not a download error: storing it failed
    }
    setDone(null);
  };
  return (
    <>
      <button className="btn lg line dl" onClick={go} disabled={done !== null} aria-busy={done !== null} style={{ '--p': `${(done ?? 0) * 100}%` } as CSSProperties}>
        {I.load}{done === null ? t('game.dl.button') : t('game.dl.progress', { pct: Math.round(done * 100) })}
      </button>
      {err && <p className="dlerr" role="alert">{err.charAt(0).toUpperCase() + err.slice(1)}</p>}
    </>
  );
}

/**
 * The game's save profiles (battery saves): which one solo play uses, and rename, duplicate,
 * export, import, delete. The link cable page lets each player pick one.
 */
function Saves({ game, header, setConfirm }: { game: GameEntry; header: RomMetadata | null; setConfirm: Dispatch<SetStateAction<ConfirmRequest | null>> }) {
  const { savedIds } = useGameLibrary(); // changes when saves are written or erased elsewhere: reload
  const [list, setList] = useState<StoredSave[] | null>(null);
  const [active, setActive] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const t = useT();
  const reload = useCallback(async () => {
    const [l, a] = await Promise.all([listProfiles(game.id), getActiveProfileId(game.id)]);
    setList(l);
    setActive(a);
    refreshSavedIds();
  }, [game.id]);
  useEffect(() => {
    let cancelled = false;
    Promise.all([listProfiles(game.id), getActiveProfileId(game.id)])
      .then(([l, a]) => { if (!cancelled) { setList(l); setActive(a); } }).catch(() => setList([]));
    return () => { cancelled = true; };
  }, [game.id, savedIds]);
  const noSave = header && header.ramSize === 'None' && !/MBC2/.test(header.cartridgeType);
  if (noSave && !list?.length) return null;

  const rename = async (p: StoredSave, name: string) => {
    setEditing(null);
    name = name.trim().slice(0, 40);
    if (!name || name === p.name) return;
    // The stored record, not the row (it may be stale): a save erased meanwhile stays erased.
    const [cur, all] = await Promise.all([getSram(p.id), listProfiles(game.id)]);
    if (cur) {
      const unique = uniqueName(all.filter((x) => x.id !== p.id), name); // two saves never share a name
      await saveSram({ ...cur, name: unique });
      if (unique !== name) toast(tNow('game.saves.renamedTo', { name, unique }), 'm');
    }
    await reload();
  };
  const duplicate = async (p: StoredSave) => {
    const [cur, all] = await Promise.all([getSram(p.id), listProfiles(game.id)]);
    if (!cur) { await reload(); return; }
    const c = await createProfile(game.id, uniqueName(all, tNow('game.saves.copyName', { name: cur.name })), cur.sram);
    await reload();
    toast(tNow('game.saves.created', { name: c.name }), 'c');
  };
  const remove = (p: StoredSave) => setConfirm({
    title: t('game.saves.deleteTitle', { name: p.name }), danger: true, ok: t('game.saves.deleteOk'),
    body: t('game.saves.deleteBody', { title: game.title, size: bytes(p.sram.length), ago: ago(p.timestamp) }),
    run: async () => { await deleteSave(p.id); await reload(); toast(tNow('game.saves.deleted', { name: p.name }), 'm'); },
  });
  const onImport = async (f: File) => {
    const r = await importSav(game, f).catch((e) => `${f.name}: ${e instanceof Error ? e.message : e}`);
    if (typeof r === 'string') { setErr(r); return; }
    setErr('');
    await reload();
    toast(tNow('game.saves.imported', { name: r.name }), 'c');
  };

  return (
    <section aria-labelledby="h-saves">
      <h3 id="h-saves">{t('game.saves.title')}</h3>
      {list && !list.length && <p className="note" style={{ margin: '0 0 14px' }}>{t('game.saves.none')}</p>}
      <ul className="profiles">
        {list?.map((p) => (
          <li key={p.id}>
            <div className="pn">
              {editing === p.id ? (
                <input className="pn-in" defaultValue={p.name} autoFocus maxLength={40} aria-label={t('game.saves.newName', { name: p.name })}
                  onBlur={(e) => rename(p, e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null); } }} />
              ) : <b>{p.name}</b>}
              {p.id === active && <span className="tag now">{t('game.saves.solo')}</span>}
              <small>{t('game.saves.meta', { size: bytes(p.sram.length), ago: ago(p.timestamp) })}</small>
            </div>
            <div className="pa">
              {p.id !== active && <button className="btn line" style={btnSm} aria-label={t('game.saves.soloOf', { name: p.name })} onClick={async () => { await setActiveProfile(game.id, p.id); await reload(); toast(tNow('game.saves.soloNow', { name: p.name }), 'c'); }}>{t('game.saves.useSolo')}</button>}
              <button className="btn line" style={btnSm} aria-label={t('game.saves.renameOf', { name: p.name })} onClick={() => setEditing(p.id)}>{t('common.rename')}</button>
              <button className="btn line" style={btnSm} aria-label={t('game.saves.duplicateOf', { name: p.name })} onClick={() => duplicate(p)}>{t('game.saves.duplicate')}</button>
              <button className="btn line" style={btnSm} aria-label={t('game.saves.exportOf', { name: p.name })} onClick={() => download(new Blob([p.sram as BlobPart]), `${game.title} - ${p.name}.sav`)}>{t('game.saves.export')}</button>
              <button className="btn danger" style={btnSm} aria-label={t('game.saves.deleteOf', { name: p.name })} onClick={() => remove(p)}>{t('common.delete')}</button>
            </div>
          </li>
        ))}
      </ul>
      <label className="btn line" style={{ ...btnSm, marginTop: 14 }} tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.querySelector('input')?.click(); } }}>
        {I.load}{t('game.saves.import')}
        <input type="file" accept={fileAccept('.sav,.srm')} className="sr" tabIndex={-1} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onImport(f); }} />
      </label>
      {err && <p className="note" role="alert" style={{ margin: '12px 0 0', color: 'var(--warn)' }}>{err}</p>}
    </section>
  );
}

