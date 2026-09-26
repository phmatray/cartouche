import { useCallback, useEffect, useState, type CSSProperties, type Dispatch, type SetStateAction } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { GameEntry } from '../../types/game';
import { refreshSavedIds, useGameLibrary } from '../../hooks/useGameLibrary';
import { createProfile, deleteSave, getActiveProfileId, getGameSaveStates, getSram, listProfiles, saveSram, setActiveProfile, uniqueName, type StoredSave, type StoredSaveState } from '../../lib/db';
import type { RomMetadata } from '../../lib/rom-utils';
import { ago, assetUrl, bytes, download, dur, owned, paths, tagOf } from '../../lib/ui';
import { I } from '../icons';
import { Cover, Title } from '../library/Cover';
import { Frame } from '../library/Heroes';
import { useInk } from '../../hooks/useInk';
import { NotFound } from '../shell/AppShell';
import { toast } from '../shell/actions';
import { ConfirmDialog, type ConfirmRequest } from '../shell/ConfirmDialog';
import { hardwareOf, importSav, useAlbum, useLinkRom, useRomHeader } from '../../hooks/useGameExtras';
import { Shot } from './Shot';

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
  const ink = useInk(game);
  const header = useRomHeader(game);
  const { shots } = useAlbum(game.id);
  const linkRom = useLinkRom(game);
  const [states, setStates] = useState<(StoredSaveState | undefined)[]>([]);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [profiles, setProfiles] = useState<StoredSave[]>([]);
  const [kind, label] = tagOf(game, savedIds);
  const need = !owned(game);
  const auto = states[0];
  const slots = Array.from({ length: 5 }, (_, i) => states[i + 1]);
  const homebrew = /homebrew/i.test(game.category);

  useEffect(() => { document.title = `${game.title} · Cartouche`; }, [game.title]);
  useEffect(() => {
    let cancelled = false;
    getGameSaveStates(game.id).then((s) => { if (!cancelled) setStates(s); }).catch(() => {});
    listProfiles(game.id).then((p) => { if (!cancelled) setProfiles(p); }).catch(() => {});
    return () => { cancelled = true; };
  }, [game.id, savedIds]);
  const profileName = (id?: string) => (profiles.length > 1 && id ? profiles.find((p) => p.id === id)?.name : undefined);

  const facts = [
    game.year, game.developer, game.genre !== 'Unknown' && game.genre,
    game.players && (game.players > 1 ? `1–${game.players} players · link cable` : '1 player'),
    game.regions?.length && (game.regions.length === 3 ? 'World' : game.regions.join(' / ')),
    homebrew && 'Homebrew',
  ].filter(Boolean) as string[];

  const remove = () => setConfirm(game.isLocal ? {
    title: 'Remove this ROM?', danger: true, ok: 'Remove ROM & saves',
    body: `${game.title}, its battery saves, resume point, save slots and screenshots are deleted from this browser. This can’t be undone.`,
    run: async () => { await deleteGame(game.id); toast(`${game.title} removed`, 'm'); navigate('/'); },
  } : {
    title: 'Erase saves?', danger: true, ok: 'Erase saves',
    body: `The battery saves, resume point, save slots and screenshots of ${game.title} are deleted. The game stays in the library.`,
    run: async () => { await eraseSaves(game.id); toast('Saves erased', 'm'); },
  });

  return (
    <main className="gp" style={{ '--flood': ink } as CSSProperties}>
      <section className="flood">
        <div className="wrap hero">
          <div className="box"><Cover game={game} className="boxart" /></div>
          <div className="info">
            <nav className="crumbs" aria-label="Breadcrumb"><Link to="/">Library</Link>{I.next}<span>{game.genre !== 'Unknown' ? game.genre : 'Game'}</span></nav>
            <h1 className="hero-t"><Title text={game.title} /></h1>
            {!!facts.length && <div className="facts">{facts.map((f) => <span key={f} className="fact">{f}</span>)}</div>}
            <div className="acts">
              {need ? (
                <label className="btn lg play" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.querySelector('input')?.click(); } }}>
                  {I.cart}Load your ROM
                  <input type="file" accept=".gb,.gbc" className="sr" tabIndex={-1}
                    onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f && await linkRom(f)) navigate(paths.play(game.id)); }} />
                </label>
              ) : (
                <Link className="btn lg play" to={paths.play(game.id, auto ? '?resume=1' : '')}>{I.play}{auto ? 'Continue' : 'Play'}</Link>
              )}
              <button className="btn lg line" aria-pressed={!!game.isFavorite} onClick={() => toggleFavorite(game.id)}>
                {game.isFavorite ? <>{I.star}Favorite</> : <>{I.starO}Add to favorites</>}
              </button>
              {!need && (game.players ?? 1) > 1 && <Link className="btn lg line" to={`/link-cable?g=${encodeURIComponent(game.id)}`}>{I.link}Link cable</Link>}
            </div>
          </div>
        </div>
      </section>

      <div className="wrap body">
        <article className="paper sheet-card">
          <h2>About this game</h2>
          {game.description && <p className="lede">{game.description}</p>}
          {need && <p className="lede" style={{ fontSize: 15 }}>This game isn’t bundled with the app. {game.homepage ? <>Get it from its author (<a href={game.homepage} target="_blank" rel="noreferrer">official page</a>), then load</> : 'Load'} the file here; it stays in this browser.</p>}
          {game.license && (
            <>
              <h3>Credits</h3>
              <p className="credit">
                {game.copyright && <>{game.copyright}. </>}
                {game.license}{game.licenseUrl && <> (<a href={assetUrl(game.licenseUrl)} target="_blank" rel="noreferrer">license</a>)</>}.
                {game.source && <> Source: <a href={game.source} target="_blank" rel="noreferrer">{game.source.replace(/^https?:\/\//, '')}</a>.</>}
                {game.homepage && <> Official page: <a href={game.homepage} target="_blank" rel="noreferrer">{game.homepage.replace(/^https?:\/\//, '')}</a>.</>}
                {game.changes && <> {game.changes}</>}
                {game.coverCredit && <> {game.coverCredit}</>}
                {game.romUrl && !game.isLocal && <> Full notices: <a href={assetUrl('THIRD_PARTY_NOTICES.txt')} target="_blank" rel="noreferrer">THIRD_PARTY_NOTICES.txt</a>.</>}
              </p>
            </>
          )}
          <h3>Cartridge</h3>
          {header ? (
            <dl className="spec">
              <div><dt>Hardware</dt><dd>{hardwareOf(header)}</dd></div>
              <div><dt>Mapper</dt><dd>{header.cartridgeType}</dd></div>
              <div><dt>ROM size</dt><dd>{header.romSize}</dd></div>
              <div><dt>Save memory</dt><dd>{header.ramSize}</dd></div>
              <div><dt>Header title</dt><dd>{header.title || '—'}</dd></div>
              <div><dt>Source</dt><dd>{game.isLocal ? 'Your file' : game.romUrl ? 'Bundled with the app' : 'Free download (homebrew)'}</dd></div>
              <div><dt>Super Game Boy</dt><dd>{header.sgbFlag === 'SGB Supported' ? 'Supported' : 'No'}</dd></div>
              <div><dt>Revision</dt><dd>{header.romVersion ? `1.${header.romVersion}` : '1.0'}</dd></div>
            </dl>
          ) : (
            <div className="empty-inline">{I.cart}<span>{need ? 'The cartridge header is read from your ROM once you load it: mapper, ROM and save size, color support.' : 'Reading the cartridge header…'}</span></div>
          )}
          <h3>Album</h3>
          {shots.length ? (
            <div className="album">
              {shots.map((s) => <figure key={s.id}><Shot png={s.png} label={`Screenshot, ${ago(s.timestamp)}`} /><figcaption>{ago(s.timestamp)}</figcaption></figure>)}
            </div>
          ) : (
            <div className="empty-inline">{I.cam}<span>No screenshots yet. Press <b>F12</b> while playing, or the camera button, to add one.</span></div>
          )}
        </article>

        <aside className="side">
          {need ? (
            <section>
              <h3>Play it</h3>
              <dl className="stats"><div><dt>Status</dt><dd><span className={`tag ${kind}`} style={{ margin: 0 }}>{label}</span></dd></div></dl>
              <p className="note" style={{ marginTop: 16 }}>Dump your own cartridge, then load the .gb file here or drop it anywhere on the page. Nothing leaves this browser.</p>
            </section>
          ) : (
            <>
              <section>
                <h3>Your play</h3>
                <dl className="stats">
                  <div><dt>Played</dt><dd>{dur(game.totalPlayTime)}</dd></div>
                  <div><dt>Sessions</dt><dd>{game.sessions ?? 0}</dd></div>
                  <div><dt>Last played</dt><dd>{game.lastPlayed ? ago(game.lastPlayed) : 'Never'}</dd></div>
                  <div><dt>Status</dt><dd><span className={`tag ${kind}`} style={{ margin: 0 }}>{label}</span></dd></div>
                </dl>
              </section>
              <Saves game={game} header={header} setConfirm={setConfirm} />
              <section>
                <h3>Save slots</h3>
                <ul className="minislots">
                  {auto && (
                    <li>
                      <span className="n" style={{ fontSize: 14 }}>Auto</span>
                      <span className="th">{auto.thumbnail.length ? <Frame rgba={auto.thumbnail} label="Resume point" /> : null}</span>
                      <span className="w">Resume point<small>{[ago(auto.timestamp), profileName(auto.profile)].filter(Boolean).join(' · ')}</small></span>
                      <Link className="btn line" style={btnSm} to={paths.play(game.id, '?resume=1')}>Resume</Link>
                    </li>
                  )}
                  {slots.map((s, i) => (
                    <li key={i}>
                      <span className="n">{i + 1}</span>
                      <span className="th">{s?.thumbnail.length ? <Frame rgba={s.thumbnail} label={`Slot ${i + 1}`} /> : null}</span>
                      <span className="w">{s ? ago(s.timestamp) : 'Empty'}{s && profileName(s.profile) && <small>{profileName(s.profile)}</small>}</span>
                      {s ? <Link className="btn line" style={btnSm} to={paths.play(game.id, `?slot=${i}`)}>Load</Link> : <span />}
                    </li>
                  ))}
                </ul>
              </section>
              <section>
                <h3>Manage</h3>
                <div className="danger-zone">
                  <span>{game.isLocal ? `${header?.romSize ?? 'Your'} ROM · stored in this browser` : 'Bundled with the app. Its saves can be erased.'}</span>
                  <button className="btn danger" onClick={remove}>{game.isLocal ? 'Remove ROM & saves' : 'Erase saves'}</button>
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
 * The game's save profiles (battery saves): which one solo play uses, and rename, duplicate,
 * export, import, delete. The link cable page lets each player pick one.
 */
function Saves({ game, header, setConfirm }: { game: GameEntry; header: RomMetadata | null; setConfirm: Dispatch<SetStateAction<ConfirmRequest | null>> }) {
  const { savedIds } = useGameLibrary(); // changes when saves are written or erased elsewhere: reload
  const [list, setList] = useState<StoredSave[] | null>(null);
  const [active, setActive] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [err, setErr] = useState('');
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
      if (unique !== name) toast(`Another save is named “${name}”: renamed to “${unique}”`, 'm');
    }
    await reload();
  };
  const duplicate = async (p: StoredSave) => {
    const [cur, all] = await Promise.all([getSram(p.id), listProfiles(game.id)]);
    if (!cur) { await reload(); return; }
    const c = await createProfile(game.id, uniqueName(all, `${cur.name} (copy)`), cur.sram);
    await reload();
    toast(`“${c.name}” created`, 'c');
  };
  const remove = (p: StoredSave) => setConfirm({
    title: `Delete “${p.name}”?`, danger: true, ok: 'Delete save',
    body: `This battery save of ${game.title} (${bytes(p.sram.length)}, last played ${ago(p.timestamp)}) is deleted from this browser. Export it first to keep a copy. This can’t be undone.`,
    run: async () => { await deleteSave(p.id); await reload(); toast(`“${p.name}” deleted`, 'm'); },
  });
  const onImport = async (f: File) => {
    const r = await importSav(game, f).catch((e) => `${f.name}: ${e instanceof Error ? e.message : e}`);
    if (typeof r === 'string') { setErr(r); return; }
    setErr('');
    await reload();
    toast(`“${r.name}” imported`, 'c');
  };

  return (
    <section aria-labelledby="h-saves">
      <h3 id="h-saves">Saves</h3>
      {list && !list.length && <p className="note" style={{ margin: '0 0 14px' }}>No battery save yet. One appears here once you play; add more for other players, or import a .sav file.</p>}
      <ul className="profiles">
        {list?.map((p) => (
          <li key={p.id}>
            <div className="pn">
              {editing === p.id ? (
                <input className="pn-in" defaultValue={p.name} autoFocus maxLength={40} aria-label={`New name for ${p.name}`}
                  onBlur={(e) => rename(p, e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null); } }} />
              ) : <b>{p.name}</b>}
              {p.id === active && <span className="tag now">Solo</span>}
              <small>{bytes(p.sram.length)} · last played {ago(p.timestamp)}</small>
            </div>
            <div className="pa">
              {p.id !== active && <button className="btn line" style={btnSm} aria-label={`Play ${p.name} solo`} onClick={async () => { await setActiveProfile(game.id, p.id); await reload(); toast(`Solo play now uses “${p.name}”`, 'c'); }}>Use for solo</button>}
              <button className="btn line" style={btnSm} aria-label={`Rename ${p.name}`} onClick={() => setEditing(p.id)}>Rename</button>
              <button className="btn line" style={btnSm} aria-label={`Duplicate ${p.name}`} onClick={() => duplicate(p)}>Duplicate</button>
              <button className="btn line" style={btnSm} aria-label={`Export ${p.name} as a .sav file`} onClick={() => download(new Blob([p.sram as BlobPart]), `${game.title} - ${p.name}.sav`)}>Export</button>
              <button className="btn danger" style={btnSm} aria-label={`Delete ${p.name}`} onClick={() => remove(p)}>Delete</button>
            </div>
          </li>
        ))}
      </ul>
      <label className="btn line" style={{ ...btnSm, marginTop: 14 }} tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.querySelector('input')?.click(); } }}>
        {I.load}Import a .sav file…
        <input type="file" accept=".sav,.srm" className="sr" tabIndex={-1} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) onImport(f); }} />
      </label>
      {err && <p className="note" role="alert" style={{ margin: '12px 0 0', color: 'var(--warn)' }}>{err}</p>}
    </section>
  );
}
