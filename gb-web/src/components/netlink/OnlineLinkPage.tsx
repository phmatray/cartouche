import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { encode } from 'uqr';
import { useGameLibrary } from '../../hooks/useGameLibrary';
import { createProfile, getActiveProfileId, getGameSaveStates, listProfiles, uniqueName, type StoredSave, type StoredSaveState } from '../../lib/db';
import { ago, bytes, linkReady, owned, paths, PLATFORM, sortTitle } from '../../lib/ui';
import { inviteUrl, parseCode, spaced } from '../../lib/p2p/code';
import { loadTurn, saveTurn, validTurn } from '../../lib/p2p/room';
import { closeRoom, hold, openRoom, other, setSeat, useNet, type Seat } from '../../lib/netlink/session';
import type { GameEntry } from '../../types/game';
import { CartridgePicker } from '../CartridgePicker';
import { Cover, NoArt } from '../library/Cover';
import { I } from '../icons';
import { toast } from '../shell/actions';
import { rich, t as tNow, useT } from '../../i18n';
import './netlink.css';

const SLOW_MS = 150;

/** The link cable over the internet: open or join a room, pick your cartridge and save, get ready, play. */
export function OnlineLinkPage() {
  const [q, setQ] = useSearchParams();
  const net = useNet();
  const t = useT();
  const invited = parseCode(q.get('room') ?? '');

  useEffect(() => { document.title = t('common.docTitle', { page: t('online.title') }); }, [t]);
  useEffect(() => hold(), []);
  // An invite link joins its room; the room open here shows in the address bar (reload-proof, shareable).
  useEffect(() => { if (invited) openRoom(invited); }, [invited]);
  useEffect(() => {
    if (net.code && net.code !== q.get('room')) setQ({ room: net.code }, { replace: true });
  }, [net.code, q, setQ]);

  return (
    <main className="wrap nl">
      <div className="pagehead">
        <h1>{t('online.title')}</h1>
        <p>{t('online.intro')}</p>
      </div>
      {net.phase === 'idle' ? <Doors /> : <Lobby />}
      <Notes />
    </main>
  );
}

/** No room yet: host one, or type a code. */
function Doors() {
  const { error } = useNet();
  const t = useT();
  const [code, setCode] = useState('');
  const [bad, setBad] = useState(false);
  const join = (e: FormEvent) => {
    e.preventDefault();
    const c = parseCode(code);
    setBad(!c);
    if (c) openRoom(c);
  };
  return (
    <div className="nl-doors paper">
      <section aria-labelledby="h-host">
        <h2 id="h-host">{t('online.doors.host')}</h2>
        <p>{t('online.doors.hostSub')}</p>
        <button className="btn y lg" onClick={() => openRoom()}>{I.link}{t('online.doors.open')}</button>
      </section>
      <section aria-labelledby="h-join">
        <h2 id="h-join">{t('online.doors.join')}</h2>
        <p>{t('online.doors.joinSub')}</p>
        <form className="nl-join" onSubmit={join}>
          <input className="nl-code-in" aria-label={t('online.doors.code')} aria-invalid={bad} aria-describedby="nl-join-err" value={code} placeholder="K7M·Q3P"
            autoCapitalize="characters" autoComplete="off" autoCorrect="off" spellCheck={false} enterKeyHint="go"
            onChange={(e) => { setCode(e.target.value); setBad(false); }} />
          <button className="btn k lg" disabled={!code.trim()}>{t('online.doors.go')}</button>
        </form>
        <small id="nl-join-err" className="nl-err" role="alert">{bad ? t('online.doors.bad') : error ? t(`online.error.${error}`) : ''}</small>
      </section>
    </div>
  );
}

interface SaveChoice { profile: string | 'new'; slot: null | 'auto' | number }
interface Saves { profiles: StoredSave[]; active: string; states: (StoredSaveState | undefined)[] }

function Lobby() {
  const net = useNet();
  const { me, peer, phase, code, ping, error } = net;
  const t = useT();
  const navigate = useNavigate();
  const [q] = useSearchParams();
  const { games } = useGameLibrary();
  const playable = useMemo(() => games.filter(owned).sort((a, b) => +linkReady(b) - +linkReady(a) || sortTitle(a.title).localeCompare(sortTitle(b.title))), [games]);
  const [pick, setPick] = useState(q.get('g') ?? '');
  const game: GameEntry | undefined = playable.find((g) => g.id === pick) ?? playable[0];
  const [picking, setPicking] = useState(false);
  const [loaded, setLoaded] = useState<{ game: string; saves: Saves } | null>(null);
  const [picked, setChoice] = useState<SaveChoice & { game: string } | null>(null);
  const saves = loaded && loaded.game === game?.id ? loaded.saves : null;
  const choice = picked && picked.game === game?.id ? picked : null;

  // Back from a game: not ready any more.
  useEffect(() => { setSeat({ ready: false, playing: false, paused: false }); }, []);
  useEffect(() => { setSeat({ game: game ? { title: game.title, platform: game.platform } : null, ready: false }); }, [game]);
  useEffect(() => {
    if (!game) return;
    let live = true;
    Promise.all([listProfiles(game.id), getActiveProfileId(game.id), getGameSaveStates(game.id)])
      .then(([profiles, active, states]) => { if (live) setLoaded({ game: game.id, saves: { profiles, active, states } }); })
      .catch(() => {}); // storage blocked: the game's usual save
    return () => { live = false; };
  }, [game]);
  const save: SaveChoice = choice ?? { profile: saves?.active ?? game?.id ?? '', slot: null };

  // Both ready: plug in (a beat for the cable to light up), then both players open their game.
  const go = phase === 'linked' && me.ready && !!peer && (peer.ready || peer.playing);
  const starting = go;
  useEffect(() => {
    if (!go || !game || !code) return;
    navigator.vibrate?.(30);
    const timer = setTimeout(async () => {
      let profile = save.profile;
      if (profile === 'new') profile = (await createProfile(game.id, uniqueName(saves?.profiles ?? [], tNow('online.save.newName')), new Uint8Array(0)).catch(() => null))?.id ?? game.id;
      const from = save.slot === null ? '' : save.slot === 'auto' ? '&resume=1' : `&slot=${save.slot}`;
      navigate(`${paths.game(game.id)}/play?online=${code}&save=${encodeURIComponent(profile)}${from}`);
    }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 200 : 1100);
    return () => clearTimeout(timer);
  }, [go]); // eslint-disable-line react-hooks/exhaustive-deps -- fires once when both are ready; the choices are fixed by then

  // Alone a while with no error: most often the other player just hasn't joined yet, sometimes a network that
  // blocks direct connections (Trystero only reports that after ~25 s). A soft hint first.
  const [slowFind, setSlowFind] = useState(false);
  useEffect(() => {
    if (phase !== 'alone') return;
    const timer = setTimeout(() => setSlowFind(true), 10_000);
    return () => { clearTimeout(timer); setSlowFind(false); };
  }, [phase]);
  const failed = error === 'connect' && phase !== 'linked';

  const them = other(me.host);
  const cable = starting ? t('online.cable.plugging') : phase === 'linked' ? (ping !== null ? t('online.cable.ms', { ms: ping }) : t('online.cable.linked'))
    : failed ? t('online.cable.failed') : phase === 'lost' ? t('online.cable.lost') : phase === 'joining' ? t('online.cable.joining') : t('online.cable.waiting');
  return (
    <>
      <Ticket code={code!} compact={phase === 'linked'} />
      {phase === 'full' && <p className="nl-warn" role="alert">{t('online.full')}</p>}
      {error ? <p className="nl-warn" role="alert">{t(`online.error.${error}`)}</p>
        : slowFind && <p className="nl-hint" role="status">{t('online.error.slow')}</p>}
      <div className={`lc nl-lc${starting ? ' go' : ''}`}>
        <section className="player" aria-labelledby="h-me">
          <h2 id="h-me"><i style={{ background: me.host ? 'var(--c)' : 'var(--m)' }} />{t('online.you', { p: me.host ? 1 : 2 })}</h2>
          <div className="ctl">{t('online.youSub')}</div>
          <div className={`nl-lcd${game ? ' lit' : ''}`} aria-hidden="true"><span>{game?.title ?? t('link.cart.none')}</span>{game && <small>{me.ready ? t('online.lcd.ready') : t('online.lcd.online')}</small>}</div>
          {game ? (
            <div className="cart">
              <div className="box" aria-hidden="true"><Cover game={game} /></div>
              <div className="info">
                <b>{game.title}</b>
                <small>{game.platform ? PLATFORM[game.platform] : ''}{linkReady(game) && <span className="tag now">{I.link}{t('link.ready')}</span>}</small>
                {game.players === 1 && <small>{t('link.cart.single')}</small>}
              </div>
              <button className="btn line" disabled={me.ready} aria-label={t('online.changeYours', { title: game.title })} onClick={() => setPicking(true)}>{t('link.cart.change')}</button>
            </div>
          ) : (
            <p className="nl-empty">{rich(t('online.noGames'), { a: (s) => <Link to="/add">{s}</Link> })}</p>
          )}
          {game && <SaveSelect game={game} saves={saves} value={save} disabled={me.ready} onChange={(c) => setChoice({ ...c, game: game.id })} />}
        </section>
        {/* The other panel's status says the same in words: the cable (and its ping) stays out of screen readers' way. */}
        <div className={`cable${phase === 'linked' ? ' on' : failed ? ' off' : ''}`} aria-hidden="true"><i /><span>{cable}</span><i /></div>
        <PeerPanel peer={peer} phase={phase} them={them} host={!me.host} failed={failed} />
      </div>
      {phase === 'linked' && ping !== null && ping > SLOW_MS && (
        <p className="nl-warn">{t('online.slow', { ms: ping })}</p>
      )}
      <div className="lc-bar">
        <button className="btn line" onClick={() => { closeRoom(); navigate('/link-cable/online', { replace: true }); toast(tNow('online.left'), 'c'); }}>{I.close}{t('online.leave')}</button>
        <div className="acts">
          {me.ready && !starting && <span className="nl-status" aria-live="polite">{peer?.ready ? '' : t('online.waitReady', { p: them })}</span>}
          <button className={`btn lg ${me.ready ? 'line' : 'y'}`} aria-pressed={me.ready} disabled={!game || starting || phase === 'full'}
            onClick={() => setSeat({ ready: !me.ready })}>
            {starting ? <>{I.link}{t('online.plugging')}</> : me.ready ? <>{I.check}{t('online.ready')}</> : <>{I.play}{t('online.imReady')}</>}
          </button>
        </div>
      </div>
      <CartridgePicker open={picking} player={me.host ? 1 : 2} games={playable} current={game?.id}
        onPick={(id) => { setPick(id); setPicking(false); }}
        onFile={() => { setPicking(false); toast(tNow('online.fromLibrary'), 'm', { label: tNow('online.addRoms'), run: () => navigate('/add') }); }}
        onClose={() => setPicking(false)} />
    </>
  );
}

/** The other end of the cable: nobody yet, or their cartridge and state. */
function PeerPanel({ peer, phase, them, host, failed }: { peer: Seat | null; phase: string; them: number; host: boolean; failed: boolean }) {
  const t = useT();
  const here = phase === 'linked' && peer;
  const state = !here ? (failed ? t('online.peer.failed') : phase === 'lost' ? t('online.peer.lost') : t('online.peer.notHere'))
    : peer.playing ? t('online.peer.inGame') : peer.ready ? t('online.peer.ready') : peer.game ? t('online.peer.save') : t('online.peer.cart');
  return (
    <section className={`player nl-peer${here ? ' here' : ''}`} aria-labelledby="h-peer">
      <h2 id="h-peer"><i style={{ background: host ? 'var(--c)' : 'var(--m)' }} />{t('link.player', { p: them })}</h2>
      <div className="ctl">{t('online.theirSub')}</div>
      <div className={`nl-lcd${here ? ' lit' : ''}`} aria-hidden="true">
        <span>{here ? (peer.game?.title ?? t('link.cart.none')) : failed ? t('online.lcd.failed') : phase === 'lost' ? t('online.lcd.lost') : t('online.lcd.waiting')}</span>
        {here ? <small>{peer.playing ? t('online.lcd.playing') : peer.ready ? t('online.lcd.ready') : t('online.lcd.online')}</small> : !failed && <b className="nl-dots"><i /><i /><i /></b>}
      </div>
      {here && peer.game && (
        <div className="cart">
          <div className="box" aria-hidden="true"><span className="cv"><NoArt game={{ title: peer.game.title, genre: 'Unknown' } as GameEntry} /></span></div>
          <div className="info"><b>{peer.game.title}</b><small>{PLATFORM[peer.game.platform as keyof typeof PLATFORM] ?? ''}</small></div>
        </div>
      )}
      <p className={`nl-state${here && (peer.ready || peer.playing) ? ' ok' : ''}`} role="status">{here && (peer.ready || peer.playing) && I.check}{state}</p>
    </section>
  );
}

/** The battery save this player plays online: one of the game's saves, a new one, or a save state to start from. */
function SaveSelect({ game, saves, value, disabled, onChange }: { game: GameEntry; saves: Saves | null; value: SaveChoice; disabled: boolean; onChange: (c: SaveChoice) => void }) {
  const t = useT();
  if (!saves) return null;
  const v = value.slot !== null ? `slot:${value.slot}` : value.profile === 'new' ? 'new' : `p:${value.profile}`;
  const known = saves.profiles.find((p) => p.id === value.profile);
  const set = (s: string) => onChange(s === 'new' ? { profile: 'new', slot: null }
    : s.startsWith('slot:') ? { profile: saves.active, slot: s === 'slot:auto' ? 'auto' : +s.slice(5) }
    : { profile: s.slice(2), slot: null });
  return (
    <div className="svp">
      <label className="sel"><span>{t('link.save.label')}</span>
        <select value={v} disabled={disabled} onChange={(e) => set(e.target.value)} aria-describedby="nl-save-note">
          <optgroup label={t('link.save.games')}>
            {saves.profiles.map((p) => <option key={p.id} value={`p:${p.id}`}>{p.name} · {ago(p.timestamp)} · {bytes(p.sram.length)}</option>)}
            {!saves.profiles.length && <option value={`p:${value.profile}`}>{t('link.save.newOf', { name: t('player.saves.main') })}</option>}
          </optgroup>
          <option value="new">{t('link.save.new')}</option>
          {saves.states.some(Boolean) && (
            <optgroup label={t('link.save.fromState')}>
              {saves.states.map((st, i) => st && <option key={i} value={i ? `slot:${i - 1}` : 'slot:auto'}>{i ? t('link.save.slot', { n: i }) : t('game.resumePoint')} · {ago(st.timestamp)}</option>)}
            </optgroup>
          )}
        </select>
      </label>
      <small id="nl-save-note">
        {value.profile === 'new' ? t('online.save.newOf', { title: game.title })
          : value.slot !== null ? t('online.save.startsFrom', { slot: value.slot === 'auto' ? t('link.save.theResume') : t('link.save.theSlot', { n: value.slot + 1 }) })
          : rich(t(known ? 'link.save.continues' : 'link.save.fresh'), { b: <b>{known ? known.name : t('player.saves.main')}</b> })}
      </small>
    </div>
  );
}

/** The invite: the code big enough to read aloud, a QR code for the phone across the table, share and copy. */
function Ticket({ code, compact }: { code: string; compact: boolean }) {
  const t = useT();
  const url = inviteUrl(code, new URL(import.meta.env.BASE_URL, location.origin).href);
  const qr = useMemo(() => encode(url, { ecc: 'M', border: 0 }), [url]);
  const path = useMemo(() => qr.data.flatMap((row, y) => row.map((on, x) => (on ? `M${x} ${y}h1v1h-1z` : ''))).join(''), [qr]);
  const copy = (text: string, done: string) => navigator.clipboard?.writeText(text).then(() => toast(done, 'c'), () => toast(tNow('online.ticket.copyFailed'), 'm'));
  const canShare = typeof navigator.share === 'function';
  return (
    <section className={`nl-ticket paper${compact ? ' compact' : ''}`} aria-labelledby="h-code">
      <svg className="nl-qr" viewBox={`-2 -2 ${qr.size + 4} ${qr.size + 4}`} role="img" aria-label={t('online.ticket.qr')} shapeRendering="crispEdges">
        <rect x="-2" y="-2" width={qr.size + 4} height={qr.size + 4} fill="#fff" /><path d={path} fill="currentColor" />
      </svg>
      <div className="nl-t-body">
        <h2 id="h-code" aria-label={t('online.ticket.code', { code: [...code].join(' ') })}>{spaced(code)}</h2>
        <p>{t('online.ticket.sub')}</p>
        <div className="nl-t-acts">
          {canShare && <button className="btn y" onClick={() => navigator.share({ title: t('online.ticket.shareTitle'), text: t('online.ticket.shareText', { code: spaced(code) }), url }).catch(() => {})}>{I.share}{t('online.ticket.share')}</button>}
          <button className={`btn ${canShare ? 'line' : 'y'}`} onClick={() => copy(url, t('online.ticket.linkCopied'))}>{I.link}{t('online.ticket.copyLink')}</button>
          <button className="btn line" onClick={() => copy(code, t('online.ticket.codeCopied'))}>{t('online.ticket.copyCode')}</button>
        </div>
        <small>{t('online.ticket.iphone')}</small>
      </div>
    </section>
  );
}

/** A URL, the same in every language. */
const TURN_EXAMPLE = 'turn:turn.example.org:3478';
const NOTES = ['direct', 'seen', 'net', 'slow', 'save'] as const;

/** How it connects, what it shares, what works and what doesn't, and the TURN server for networks that need one. */
function Notes() {
  const t = useT();
  const failed = useNet((s) => s.error === 'connect');
  const [turn, setTurn] = useState(() => loadTurn() ?? { urls: '', username: '', credential: '' });
  const [saved, setSaved] = useState(!!loadTurn());
  const ok = !turn.urls.trim() || validTurn(turn.urls);
  return (
    <section className="nl-notes paper" aria-labelledby="h-notes">
      <h2 id="h-notes">{t('online.notes.title')}</h2>
      <dl>
        {NOTES.map((n) => <div key={n}><dt>{t(`online.notes.${n}T`)}</dt><dd>{t(`online.notes.${n}`)}</dd></div>)}
      </dl>
      {/* Open when a TURN server is set, and the moment one looks needed. */}
      <details className="nl-turn" open={saved || failed || undefined}>
        <summary>{t('online.turn.title')}</summary>
        <p>{t('online.turn.sub')}</p>
        <form onSubmit={(e) => { e.preventDefault(); if (!ok) return; saveTurn(turn.urls.trim() ? turn : null); setSaved(!!turn.urls.trim()); toast(turn.urls.trim() ? tNow('online.turn.saved') : tNow('online.turn.removed'), 'c'); }}>
          <label><span>{t('online.turn.url')}</span><input className="field" value={turn.urls} placeholder={TURN_EXAMPLE} aria-invalid={!ok} spellCheck={false} autoCapitalize="off"
            onChange={(e) => setTurn({ ...turn, urls: e.target.value })} /></label>
          <label><span>{t('online.turn.user')}</span><input className="field" value={turn.username} autoComplete="off" autoCapitalize="off" onChange={(e) => setTurn({ ...turn, username: e.target.value })} /></label>
          <label><span>{t('online.turn.credential')}</span><input className="field" type="password" value={turn.credential} autoComplete="off" onChange={(e) => setTurn({ ...turn, credential: e.target.value })} /></label>
          <button className="btn k" disabled={!ok}>{t('common.save')}</button>
        </form>
        {!ok && <small className="nl-err" role="alert">{t('online.turn.bad')}</small>}
      </details>
      <p className="nl-alt">{rich(t('online.alt'), { a: (s) => <Link to="/link-cable">{s}</Link> })}</p>
    </section>
  );
}
