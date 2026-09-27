import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { GameEntry } from '../../types/game';
import { fetchRom, recordSession, useGameLibrary } from '../../hooks/useGameLibrary';
import { useEmulator } from '../../hooks/useEmulator';
import { useAudio } from '../../hooks/useAudio';
import { useGamepad } from '../../hooks/useGamepad';
import { useLcdShader } from '../../hooks/useLcdShader';
import { useRewind } from '../../hooks/useRewind';
import { useSaveData } from '../../hooks/useSaveData';
import { useSaveStates, type SlotKey } from '../../hooks/useSaveStates';
import { useAnimationFrame } from '../../hooks/useAnimationFrame';
import { CHANNEL_KEYS, useDisplay, useSettingsStore } from '../../store/settingsStore';
import { presetOf } from '../../shaders/filters';
import { BUTTON_NUMBERS } from '../../utils/keybindings';
import { getActiveProfileId, getSram } from '../../lib/db';
import { ago, owned, paths, tagOf } from '../../lib/ui';
import { settled } from '../../lib/transitions';
import { I } from '../icons';
import { Title } from '../library/Cover';
import { useInk } from '../../hooks/useInk';
import { NotFound } from '../shell/AppShell';
import { toast } from '../shell/actions';
import { Toasts } from '../shell/Toasts';
import { ConfirmDialog, type ConfirmRequest } from '../shell/ConfirmDialog';
import { useAlbum, useLinkRom, useRomHeader } from '../../hooks/useGameExtras';
import { Manual, type Tab } from './Manual';
import { fileAccept } from '../../lib/pwa';
import { t as tNow, useT } from '../../i18n';

const FPS = 4194304 / 70224; // 59.73 Hz, the Game Boy's real frame rate
const SPEEDS = [0.5, 1, 2, 4];
const typing = () => {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (/INPUT|SELECT|TEXTAREA/.test(el.tagName) || el.isContentEditable);
};

/**
 * iOS starts a selection, the magnifier or a double-tap zoom from a touch unless its touchstart is cancelled, which
 * React's (passive) touch listeners can't do. The pads run on pointer events, which still arrive.
 */
function holdTouches(el: HTMLElement | null) {
  if (!el) return;
  const stop = (e: TouchEvent) => e.preventDefault();
  el.addEventListener('touchstart', stop, { passive: false });
  return () => el.removeEventListener('touchstart', stop);
}

export function PlayerPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { getGameById, loading } = useGameLibrary();
  const game = getGameById(id);
  if (loading) return <div className="pl" aria-busy="true" />;
  if (!game) return <NotFound />;
  return <Player key={game.id} game={game} />;
}

function Player({ game }: { game: GameEntry }) {
  const [q] = useSearchParams();
  const { savedIds, storageError, deleteGame } = useGameLibrary();
  const navigate = useNavigate();
  const t = useT();
  const emu = useEmulator();
  const { isReady, isRunning, setIsRunning, romLoaded, isCgb, loadRom, runFrame, getAudioSamples, pressButton, releaseButton,
    errors, hasBatteryRam, exportSram, importSram, saveState, loadState, framebufferSnapshot, setTraceEnabled, getTrace } = emu;
  const keybindings = useSettingsStore((s) => s.keybindings);
  const rewindSeconds = useSettingsStore((s) => s.rewindBufferSeconds);
  const screenSize = useSettingsStore((s) => s.screenSize);
  const channelMutes = useSettingsStore((s) => s.channelMutes);
  const touchSize = useSettingsStore((s) => s.touchSize);
  const smoothMotion = useSettingsStore((s) => s.smoothMotion);
  const smoothMotionForce = useSettingsStore((s) => s.smoothMotionForce);
  const [speed, setSpeed] = useState(() => useSettingsStore.getState().defaultSpeed);
  const [tab, setTab] = useState<Tab>(() => (q.get('tab') as Tab) || 'controls');
  const [manual, setManual] = useState(() => !!q.get('tab') || !matchMedia('(max-width:900px)').matches);
  const [needsRom, setNeedsRom] = useState(!owned(game));
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [savedJustNow, setSavedJustNow] = useState(false);
  const [badRom, setBadRom] = useState(false);
  const [idle, setIdle] = useState(false);
  const [lit, setLit] = useState(false); // the first frame is on the LCD (it fades in over the dark screen)
  const rootRef = useRef<HTMLDivElement>(null);
  const ink = useInk(game);
  const header = useRomHeader(game);
  const album = useAlbum(game.id);
  const linkRom = useLinkRom(game);

  // A cartridge the core runs in Game Boy Color mode keeps its own colours: DMG palettes never apply to it,
  // and it has its own default screen settings (the core decides, from header byte 0x143 bit 7).
  const inColor = romLoaded && isCgb;
  const display = useDisplay(inColor ? 'cgb' : 'dmg', game.id);
  const { canvasRef, canvasKey, renderFrame, setMotion, drawMotion, usesTrace } = useLcdShader(display.cfg.filters, inColor);
  const { ensureStarted, feedSamples, muted, toggleMute } = useAudio();
  const saveTo = useRef<string | null>(null); // the save profile played solo (the game's active one)
  // Every state load (slot, resume point, rewind step) draws its picture at once, paused or not, with no ghosting from before the jump.
  const loadAndShow = useCallback((data: Uint8Array, frame?: Uint8Array | Uint8ClampedArray) => {
    if (!loadState(data, frame)) return false;
    const fb = framebufferSnapshot();
    if (fb) { renderFrame(new Uint8ClampedArray(fb.buffer, fb.byteOffset, fb.length), true); setLit(true); }
    return true;
  }, [loadState, framebufferSnapshot, renderFrame]);
  const saves = useSaveStates(game.id, { ...emu, loadState: loadAndShow }, saveTo);
  const { isRewinding, startRewind, stopRewind, wrapRunFrame, bufferFill } = useRewind({ saveState, loadState: loadAndShow });
  useSaveData({ saveTo, romLoaded, hasBatteryRam, exportSram });

  // No Fullscreen API on iPhone (nor in its Home Screen apps): "immersive" hides the chrome instead and gives the screen all the room.
  const [immersive, setImmersive] = useState(false);
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenEnabled) setImmersive((v) => !v);
    else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else rootRef.current?.requestFullscreen().catch(() => {});
  }, []);
  const { connected: gamepad } = useGamepad(pressButton, releaseButton, romLoaded, toggleFullscreen);

  useEffect(() => { document.title = t('common.docTitle', { page: game.title }); }, [game.title, t]);
  // Settings › Audio › Channels (applied again after each ROM load: the core resets with the cartridge).
  const { setChannelMuted } = emu;
  useEffect(() => {
    if (romLoaded) CHANNEL_KEYS.forEach((k, i) => setChannelMuted(i, channelMutes[k]));
  }, [romLoaded, channelMutes, setChannelMuted]);
  useEffect(() => { if (errors.length && !badRom) toast(errors[errors.length - 1].message, 'm'); }, [errors, badRom]);

  // Fullscreen: the deck overlays the screen and hides after 2.5 s without pointer or key activity.
  useEffect(() => {
    let t = 0;
    const wake = () => { setIdle(false); clearTimeout(t); t = window.setTimeout(() => setIdle(true), 2500); };
    wake();
    const events = ['pointermove', 'pointerdown', 'keydown'];
    events.forEach((e) => window.addEventListener(e, wake));
    return () => { clearTimeout(t); events.forEach((e) => window.removeEventListener(e, wake)); };
  }, []);

  // Audio can only start after a user gesture: the click that opened the player usually counts, else the next key or tap.
  // Every one tries again (a no-op while it plays): iOS only unlocks on a touch it counts as a gesture (touchend),
  // and suspends the sound again after a call or a trip to the Home Screen.
  useEffect(() => {
    const start = () => { ensureStarted().catch(() => {}); };
    // After the landing: creating the AudioContext blocks the main thread (the click still counts as the gesture).
    settled().then(start);
    const events = ['pointerdown', 'touchend', 'keydown'];
    events.forEach((e) => window.addEventListener(e, start));
    return () => events.forEach((e) => window.removeEventListener(e, start));
  }, [ensureStarted]);

  /** Boot a ROM: cartridge save first, then the requested resume point or slot, then run. */
  const boot = useCallback(async (data: Uint8Array) => {
    if (!loadRom(data)) { setBadRom(true); return; }
    setNeedsRom(false);
    if (hasBatteryRam()) {
      const id = await getActiveProfileId(game.id).catch(() => game.id);
      const sram = await getSram(id).catch(() => undefined);
      if (sram) importSram(sram.sram);
      saveTo.current = id;
    }
    const slot = q.get('slot');
    const from: SlotKey | null = q.get('resume') ? 'auto' : slot !== null ? +slot : null;
    if (from !== null) {
      const ok = await saves.load(from);
      toast(ok ? (from === 'auto' ? tNow('player.toast.resumed') : tNow('player.toast.loadedSlot', { n: String(+from + 1) })) : tNow('player.toast.gone'), ok ? 'c' : 'm');
    }
    setIsRunning(true);
  }, [loadRom, hasBatteryRam, importSram, game.id, q, saves, setIsRunning]);

  const booted = useRef(false);
  useEffect(() => {
    if (!isReady || booted.current || !owned(game)) return;
    booted.current = true;
    fetchRom(game).then(boot).catch((e) => toast(tNow('player.toast.loadFailed', { error: e instanceof Error ? e.message : String(e) }), 'm'));
  }, [isReady, game, boot]);

  // ---- frame loop: real-time paced (60 Hz or 120 Hz screens alike), speed ½–4× ----
  const pace = useRef({ last: 0, acc: 0 });
  const played = useRef(0); // seconds actually emulated this session
  const dirty = useRef(false); // something ran since the last resume point
  const speedRef = useRef(speed);
  useEffect(() => { speedRef.current = speed; }, [speed]);
  const runOne = useCallback(() => {
    const fb = runFrame();
    const samples = getAudioSamples(); // always drained; only played at ≤ 1×
    if (samples && speedRef.current <= 1) feedSamples(samples);
    return fb;
  }, [runFrame, getAudioSamples, feedSamples]);
  // Display refresh rate, from the time between animation frames (median of the last 31).
  const refresh = useRef<number[]>([]);
  const onFrame = useCallback(() => {
    const now = performance.now();
    const p = pace.current;
    const dt = p.last ? Math.min(0.1, (now - p.last) / 1000) : 1 / FPS;
    if (p.last) { refresh.current.push(dt); if (refresh.current.length > 31) refresh.current.shift(); }
    p.last = now;
    p.acc += dt * FPS * speedRef.current;
    let n = Math.min(8, Math.floor(p.acc));
    p.acc -= n;
    if (isRewinding) n = 1; // rewind runs at its own pace, whatever the speed
    // Smooth motion only where it makes sense: a display faster than the Game Boy (or forced), normal speed, no rewind.
    const hz = refresh.current.length >= 15 ? 1 / [...refresh.current].sort((a, b) => a - b)[refresh.current.length >> 1] : 60;
    const motion = smoothMotion && (smoothMotionForce || hz > 75) && speedRef.current === 1 && !isRewinding;
    setMotion(motion);
    const traced = usesTrace(); // only while Neural 4× really runs its tile path, or Smooth motion is on
    setTraceEnabled(traced);
    let fb: Uint8ClampedArray | null = null;
    for (let i = 0; i < n; i++) fb = wrapRunFrame(runOne) ?? fb;
    const trace = fb && traced && !isRewinding ? getTrace() : null; // a rewound frame has no trace of its own
    if (fb) { renderFrame(fb, false, trace, p.acc); setLit(true); }
    else if (motion) drawMotion(p.acc);
    if (n) { played.current += dt; dirty.current = true; }
  }, [wrapRunFrame, runOne, renderFrame, isRewinding, smoothMotion, smoothMotionForce, setTraceEnabled, getTrace, setMotion, drawMotion, usesTrace]);
  const looping = romLoaded && (isRunning || isRewinding);
  useEffect(() => { if (!looping) { pace.current.last = 0; refresh.current = []; } }, [looping]);
  useAnimationFrame(onFrame, looping);

  // ---- resume point + play time, written when leaving (route change, tab hidden, page closed) ----
  const saveAuto = saves.save;
  // Play time is flushed with every resume-point save (not only on leave): a pagehide write
  // can be cut off by the unload, so a reload or closed tab would otherwise lose the session.
  const sessionCounted = useRef(false);
  useEffect(() => { sessionCounted.current = false; }, [game.id]);
  const leave = useCallback(() => {
    if (dirty.current && useSettingsStore.getState().resumePoints) { dirty.current = false; saveAuto('auto'); }
    const seconds = Math.floor(played.current);
    if (seconds >= 1) {
      played.current -= seconds;
      recordSession(game.id, seconds, !sessionCounted.current);
      sessionCounted.current = true;
    }
  }, [saveAuto, game.id]);
  const leaveRef = useRef(leave);
  useEffect(() => { leaveRef.current = leave; }, [leave]);
  // Also every 30 s while running, so a crash or a killed tab loses at most that much.
  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => leaveRef.current(), 30_000);
    return () => clearInterval(t);
  }, [isRunning]);
  // The screen stays awake while a game runs. The browser drops the lock when the page is hidden: taken again on return.
  useEffect(() => {
    if (!isRunning || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | undefined, gone = false;
    const take = () => {
      if (document.visibilityState !== 'visible' || (lock && !lock.released)) return;
      navigator.wakeLock.request('screen').then((l) => { if (gone) l.release(); else lock = l; }).catch(() => {});
    };
    take();
    document.addEventListener('visibilitychange', take);
    return () => { gone = true; document.removeEventListener('visibilitychange', take); lock?.release().catch(() => {}); };
  }, [isRunning]);
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') leaveRef.current(); };
    const onPageHide = () => leaveRef.current();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      const wasDirty = dirty.current && useSettingsStore.getState().resumePoints;
      leaveRef.current();
      if (wasDirty) toast(tNow('player.toast.resumeSaved', { title: game.title }), 'm');
    };
  }, [game.title]);

  // ---- actions ----
  const play = useCallback(() => { ensureStarted().catch(() => {}); setIsRunning(true); }, [ensureStarted, setIsRunning]);
  const togglePlay = useCallback(() => (isRunning ? setIsRunning(false) : play()), [isRunning, setIsRunning, play]);
  const saveSlot = useCallback(async (i: number) => {
    if (!romLoaded || !(await saves.save(i))) return;
    setSavedJustNow(true);
    toast(tNow('player.toast.saved', { n: String(i + 1) }), 'm');
  }, [romLoaded, saves]);
  const loadSlot = useCallback(async (k: SlotKey) => {
    if (!romLoaded) return;
    if (await saves.load(k)) toast(k === 'auto' ? tNow('player.toast.loadedResume') : tNow('player.toast.loadedSlot', { n: String(k + 1) }), 'c');
    else toast(k === 'auto' ? tNow('player.toast.noResume') : tNow('player.toast.emptySlot', { n: String(k + 1) }), 'm');
  }, [romLoaded, saves]);
  const screenshot = useCallback(async () => {
    const rgba = romLoaded && framebufferSnapshot();
    if (!rgba) return;
    await album.add(rgba);
    toast(tNow('player.toast.shot'), '', { label: tNow('player.toast.view'), run: () => { setTab('album'); setManual(true); } });
  }, [romLoaded, framebufferSnapshot, album]);
  const mute = useCallback(() => { toggleMute(); toast(muted ? tNow('player.toast.soundOn') : tNow('player.toast.soundOff'), 'c'); }, [toggleMute, muted]);

  // ---- keyboard: game buttons from Settings, then player shortcuts ----
  const actions = useRef({ togglePlay, saveSlot, loadSlot, screenshot, mute, toggleFullscreen, startRewind, stopRewind });
  useEffect(() => { actions.current = { togglePlay, saveSlot, loadSlot, screenshot, mute, toggleFullscreen, startRewind, stopRewind }; });
  useEffect(() => {
    const buttonOf = (key: string) => {
      for (const [b, k] of Object.entries(keybindings)) if (k === key || k.toLowerCase() === key.toLowerCase()) return BUTTON_NUMBERS[b];
      return undefined;
    };
    const down = (e: KeyboardEvent) => {
      if (typing() || document.querySelector('dialog[open]') || e.ctrlKey || e.metaKey || e.altKey) return;
      const a = actions.current;
      const b = buttonOf(e.key);
      if (b !== undefined) { e.preventDefault(); if (!e.repeat) pressButton(b); return; }
      const k = e.key.toLowerCase();
      const run = { f5: () => a.saveSlot(0), f8: () => a.loadSlot(0), f12: a.screenshot, p: a.togglePlay, m: a.mute, f: a.toggleFullscreen, r: a.startRewind }[k];
      if (!run) return;
      e.preventDefault();
      if (!e.repeat) run();
    };
    const up = (e: KeyboardEvent) => {
      const b = buttonOf(e.key);
      if (b !== undefined) releaseButton(b);
      else if (e.key.toLowerCase() === 'r') actions.current.stopRewind();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [keybindings, pressButton, releaseButton]);

  const auto = saves.states[0];
  const [kind, label] = tagOf(game, savedIds);
  const status = needsRom ? label : savedJustNow ? t('player.savedNow') : auto ? t('player.resumeAgo', { ago: ago(auto.timestamp) }) : label;
  // A fixed size (2×–4×) is the most the screen takes: the CSS still shrinks it to the room there is.
  const screenStyle = screenSize === 'fit' ? undefined : { '--sw': `${160 * +screenSize + 24}px` } as CSSProperties;
  const disabled = !romLoaded;
  const noStore = disabled || storageError; // save slots and the album need IndexedDB
  const pad = (b: string) => ({
    'data-pad': b,
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      // Capture can throw (pointer already released or cancelled by the system): never lose the press over it.
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* keep going */ }
      e.currentTarget.classList.add('down');
      if (useSettingsStore.getState().haptics) navigator.vibrate?.(8);
      pressButton(BUTTON_NUMBERS[b]);
    },
    onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => { e.currentTarget.classList.remove('down'); releaseButton(BUTTON_NUMBERS[b]); },
    onPointerCancel: (e: React.PointerEvent<HTMLButtonElement>) => { e.currentTarget.classList.remove('down'); releaseButton(BUTTON_NUMBERS[b]); },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });

  return (
    <div ref={rootRef} className={`pl${manual ? '' : ' closed'}${idle ? ' idle' : ''}${immersive ? ' imm' : ''}`} style={{ '--flood': ink } as CSSProperties}>
      <header className="pl-top">
        <Link className="back" to={paths.game(game.id)}>{I.back}<span className="lbl">{t('common.back')}</span></Link>
        <h1><Link to={paths.game(game.id)} title={game.title}><Title text={game.title} /></Link></h1>
        <span className={`tag ${savedJustNow || auto ? 'saved' : kind}`}>{status}</span>
        <div className="right">
          <span className={`pad${gamepad ? ' on' : ''}`}><i /><span>{gamepad ? t('player.gamepad') : t('player.noGamepad')}</span></span>
          <button className="manual-btn" aria-expanded={manual} aria-controls="sheet" onClick={() => setManual(!manual)}>{I.book}<span>{t('player.manual')}</span></button>
        </div>
      </header>

      <div className="pl-body">
        <div className="stage" style={screenStyle}>
          <div className={`rw${isRewinding ? ' on' : ''}`}>{I.rew}{t('player.rewinding')}<span className="meter"><i style={{ width: `${bufferFill * 100}%` }} /></span></div>
          <div className="screen">
            <div className="frame">
              <canvas key={canvasKey} ref={canvasRef} className={`lcd${lit ? ' lit' : ''}`} width={800} height={720} aria-label={t('player.screenOf', { title: game.title })} />
              {badRom ? (
                <div className="overlay">
                  <b>{t('player.bad.title')}</b>
                  <p>{t('player.bad.body')}</p>
                  <div className="acts">
                    {game.isLocal && <button className="btn y" onClick={async () => { await deleteGame(game.id); toast(tNow('game.removed', { title: game.title }), 'm'); navigate('/'); }}>{t('player.bad.remove')}</button>}
                    <Link className="btn line" to={paths.game(game.id)}>{t('common.back')}</Link>
                  </div>
                </div>
              ) : needsRom ? (
                <div className="overlay">
                  <b>{t('player.insert.title')}</b>
                  <p>{t('player.insert.body', { title: game.title })}</p>
                  <label className="btn y" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.querySelector('input')?.click(); } }}>
                    {I.cart}{t('game.loadRom')}
                    <input type="file" accept={fileAccept('.gb,.gbc,.zip')} className="sr" tabIndex={-1}
                      onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; const data = f && await linkRom(f); if (data) boot(data); }} />
                  </label>
                </div>
              ) : romLoaded && !isRunning && !isRewinding && (
                <div className="overlay"><b>{t('player.paused')}</b><p>{t('player.pausedSub')}</p></div>
              )}
            </div>
          </div>
          <div className="cap">
            <span>{display.custom ? t('settings.screen.custom') : t(`settings.screen.presets.${presetOf(display.cfg.preset)!.name}.label`)}</span><i /><span>{t('player.speed', { x: speed === 0.5 ? '½' : String(speed) })}</span><i /><span>{t('player.rewindReady', { s: String(Math.round(bufferFill * rewindSeconds)) })}</span>
          </div>
        </div>

        <Manual
          game={game} header={header} inColor={inColor} tab={tab} onTab={setTab} romLoaded={romLoaded && !storageError} isRunning={isRunning}
          states={saves.states} shots={album.shots} emu={emu}
          onSave={(i) => (saves.states[i + 1]
            ? setConfirm({ title: t('player.overwrite.title', { n: String(i + 1) }), body: t('player.overwrite.body', { ago: ago(saves.states[i + 1]!.timestamp) }), ok: t('player.overwrite.ok'), run: () => saveSlot(i) })
            : saveSlot(i))}
          onLoad={loadSlot} onScreenshot={screenshot}
        />
      </div>

      <nav className="deck" aria-label={t('player.deck.label')}>
        <button className="dk main" onClick={togglePlay} disabled={disabled} aria-label={isRunning ? t('player.deck.pauseP') : t('player.deck.playP')}>
          {isRunning ? <>{I.pause}<span className="lbl">{t('player.deck.pause')}</span></> : <>{I.play}<span className="lbl">{t('library.hero.play')}</span></>}<span className="k">P</span>
        </button>
        <button className="dk" aria-label={t('player.deck.rewindR')} aria-pressed={isRewinding} disabled={disabled}
          onPointerDown={startRewind} onPointerUp={stopRewind} onPointerLeave={stopRewind} onPointerCancel={stopRewind}>
          {I.rew}<span className="lbl">{t('player.deck.rewind')}</span><span className="k">{t('player.deck.holdR')}</span>
        </button>
        <span className="gap" />
        <div className="speed" role="group" aria-label={t('player.deck.speed')}>
          {SPEEDS.map((s) => <button key={s} aria-pressed={speed === s} onClick={() => setSpeed(s)}>{s === 0.5 ? '½' : s}×</button>)}
        </div>
        {/* Narrow phones: one button steps through the speeds (the group doesn't fit). */}
        <button className="dk spd" onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])} aria-label={t('player.deck.speedChange', { x: String(speed) })}>{speed === 0.5 ? '½' : speed}×</button>
        <span className="gap" />
        <button className="dk" onClick={() => saveSlot(0)} disabled={noStore} aria-label={t('player.deck.saveF5')}>{I.save}<span className="lbl">{t('common.save')}</span><span className="k">F5</span></button>
        <button className="dk hide-m" onClick={() => loadSlot(0)} disabled={noStore} aria-label={t('player.deck.loadF8')}>{I.load}<span className="lbl">{t('common.load')}</span><span className="k">F8</span></button>
        <button className="dk hide-m" onClick={screenshot} disabled={noStore} aria-label={t('player.deck.shotF12')}>{I.cam}<span className="lbl">{t('player.deck.photo')}</span><span className="k">F12</span></button>
        <span className="push" />
        <button className="dk hide-m" onClick={mute} aria-pressed={muted} aria-label={t('player.deck.muteM')}>{muted ? I.mute : I.sound}</button>
        {document.fullscreenEnabled
          ? <button className="dk fs" onClick={toggleFullscreen} aria-label={t('player.deck.fullF')}>{I.full}</button>
          : <button className="dk fs" onClick={toggleFullscreen} aria-pressed={immersive} aria-label={immersive ? t('player.deck.leaveImmF') : t('player.deck.immF')}>{immersive ? I.close : I.full}</button>}
      </nav>

      <div className="touch" ref={holdTouches} data-size={touchSize} aria-label={t('player.touch.label')}>
        <div className="dpad">
          <span className="c" />
          <button className="u" aria-label={t('player.touch.up')} {...pad('Up')}>{I.up}</button>
          <button className="d" aria-label={t('player.touch.down')} {...pad('Down')}>{I.down}</button>
          <button className="l" aria-label={t('player.touch.left')} {...pad('Left')}>{I.left}</button>
          <button className="r" aria-label={t('player.touch.right')} {...pad('Right')}>{I.right}</button>
        </div>
        <div className="ab"><button className="b" {...pad('B')}>B</button><button className="a" {...pad('A')}>A</button></div>
        <div className="ss"><button {...pad('Select')}>Select</button><button {...pad('Start')}>Start</button></div>
      </div>

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      <Toasts />
    </div>
  );
}
