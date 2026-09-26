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
import { I } from '../icons';
import { Title } from '../library/Cover';
import { useInk } from '../../hooks/useInk';
import { NotFound } from '../shell/AppShell';
import { toast } from '../shell/actions';
import { Toasts } from '../shell/Toasts';
import { ConfirmDialog, type ConfirmRequest } from '../shell/ConfirmDialog';
import { useAlbum, useLinkRom, useRomHeader } from '../../hooks/useGameExtras';
import { Manual, type Tab } from './Manual';

const FPS = 4194304 / 70224; // 59.73 Hz, the Game Boy's real frame rate
const SPEEDS = [0.5, 1, 2, 4];
const typing = () => {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (/INPUT|SELECT|TEXTAREA/.test(el.tagName) || el.isContentEditable);
};

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
  const emu = useEmulator();
  const { isReady, isRunning, setIsRunning, romLoaded, isCgb, loadRom, runFrame, getAudioSamples, pressButton, releaseButton,
    errors, hasBatteryRam, exportSram, importSram, saveState, loadState, framebufferSnapshot } = emu;
  const keybindings = useSettingsStore((s) => s.keybindings);
  const rewindSeconds = useSettingsStore((s) => s.rewindBufferSeconds);
  const screenSize = useSettingsStore((s) => s.screenSize);
  const channelMutes = useSettingsStore((s) => s.channelMutes);
  const touchSize = useSettingsStore((s) => s.touchSize);
  const [speed, setSpeed] = useState(() => useSettingsStore.getState().defaultSpeed);
  const [tab, setTab] = useState<Tab>(() => (q.get('tab') as Tab) || 'controls');
  const [manual, setManual] = useState(() => !!q.get('tab') || !matchMedia('(max-width:900px)').matches);
  const [needsRom, setNeedsRom] = useState(!owned(game));
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [savedJustNow, setSavedJustNow] = useState(false);
  const [badRom, setBadRom] = useState(false);
  const [idle, setIdle] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const ink = useInk(game);
  const header = useRomHeader(game);
  const album = useAlbum(game.id);
  const linkRom = useLinkRom(game);

  // A cartridge the core runs in Game Boy Color mode keeps its own colours: DMG palettes never apply to it,
  // and it has its own default screen settings (the core decides, from header byte 0x143 bit 7).
  const inColor = romLoaded && isCgb;
  const display = useDisplay(inColor ? 'cgb' : 'dmg', game.id);
  const { canvasRef, canvasKey, renderFrame } = useLcdShader(display.cfg.filters, inColor);
  const { ensureStarted, feedSamples, muted, toggleMute } = useAudio();
  const saveTo = useRef<string | null>(null); // the save profile played solo (the game's active one)
  // Every state load (slot, resume point, rewind step) draws its picture at once, paused or not, with no ghosting from before the jump.
  const loadAndShow = useCallback((data: Uint8Array, frame?: Uint8Array | Uint8ClampedArray) => {
    if (!loadState(data, frame)) return false;
    const fb = framebufferSnapshot();
    if (fb) renderFrame(new Uint8ClampedArray(fb.buffer, fb.byteOffset, fb.length), true);
    return true;
  }, [loadState, framebufferSnapshot, renderFrame]);
  const saves = useSaveStates(game.id, { ...emu, loadState: loadAndShow }, saveTo);
  const { isRewinding, startRewind, stopRewind, wrapRunFrame, bufferFill } = useRewind({ saveState, loadState: loadAndShow });
  useSaveData({ saveTo, romLoaded, hasBatteryRam, exportSram });

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else rootRef.current?.requestFullscreen().catch(() => {});
  }, []);
  const { connected: gamepad } = useGamepad(pressButton, releaseButton, romLoaded, toggleFullscreen);

  useEffect(() => { document.title = `${game.title} · Cartouche`; }, [game.title]);
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
    window.addEventListener('pointermove', wake);
    window.addEventListener('keydown', wake);
    return () => { clearTimeout(t); window.removeEventListener('pointermove', wake); window.removeEventListener('keydown', wake); };
  }, []);

  // Audio can only start after a user gesture: the click that opened the player usually counts, else the first key or tap.
  useEffect(() => {
    const start = () => { ensureStarted().catch(() => {}); };
    start();
    window.addEventListener('pointerdown', start, { once: true });
    window.addEventListener('keydown', start, { once: true });
    return () => { window.removeEventListener('pointerdown', start); window.removeEventListener('keydown', start); };
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
      toast(ok ? (from === 'auto' ? 'Resumed where you left off' : `Loaded slot ${+from + 1}`) : 'That save is gone. Starting fresh.', ok ? 'c' : 'm');
    }
    setIsRunning(true);
  }, [loadRom, hasBatteryRam, importSram, game.id, q, saves, setIsRunning]);

  const booted = useRef(false);
  useEffect(() => {
    if (!isReady || booted.current || !owned(game)) return;
    booted.current = true;
    fetchRom(game).then(boot).catch((e) => toast(`Couldn’t load the ROM: ${e instanceof Error ? e.message : e}`, 'm'));
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
  const onFrame = useCallback(() => {
    const now = performance.now();
    const p = pace.current;
    const dt = p.last ? Math.min(0.1, (now - p.last) / 1000) : 1 / FPS;
    p.last = now;
    p.acc += dt * FPS * speedRef.current;
    let n = Math.min(8, Math.floor(p.acc));
    p.acc -= n;
    if (isRewinding) n = 1; // rewind runs at its own pace, whatever the speed
    let fb: Uint8ClampedArray | null = null;
    for (let i = 0; i < n; i++) fb = wrapRunFrame(runOne) ?? fb;
    if (fb) renderFrame(fb);
    if (n) { played.current += dt; dirty.current = true; }
  }, [wrapRunFrame, runOne, renderFrame, isRewinding]);
  const looping = romLoaded && (isRunning || isRewinding);
  useEffect(() => { if (!looping) pace.current.last = 0; }, [looping]);
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
      if (wasDirty) toast(`Resume point saved for ${game.title}`, 'm');
    };
  }, [game.title]);

  // ---- actions ----
  const play = useCallback(() => { ensureStarted().catch(() => {}); setIsRunning(true); }, [ensureStarted, setIsRunning]);
  const togglePlay = useCallback(() => (isRunning ? setIsRunning(false) : play()), [isRunning, setIsRunning, play]);
  const saveSlot = useCallback(async (i: number) => {
    if (!romLoaded || !(await saves.save(i))) return;
    setSavedJustNow(true);
    toast(`Saved to slot ${i + 1}`, 'm');
  }, [romLoaded, saves]);
  const loadSlot = useCallback(async (k: SlotKey) => {
    if (!romLoaded) return;
    if (await saves.load(k)) toast(`Loaded ${k === 'auto' ? 'the resume point' : `slot ${k + 1}`}`, 'c');
    else toast(k === 'auto' ? 'No resume point yet' : `Slot ${k + 1} is empty`, 'm');
  }, [romLoaded, saves]);
  const screenshot = useCallback(async () => {
    const rgba = romLoaded && framebufferSnapshot();
    if (!rgba) return;
    await album.add(rgba);
    toast('Screenshot added to the album', '', { label: 'View', run: () => { setTab('album'); setManual(true); } });
  }, [romLoaded, framebufferSnapshot, album]);
  const mute = useCallback(() => { toggleMute(); toast(muted ? 'Sound on' : 'Sound off', 'c'); }, [toggleMute, muted]);

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
  const status = needsRom ? label : savedJustNow ? 'Saved just now' : auto ? `Resume point ${ago(auto.timestamp)}` : label;
  const screenStyle: CSSProperties | undefined = screenSize === 'fit' ? undefined : { width: 160 * +screenSize + 24, maxWidth: '100%' };
  const disabled = !romLoaded;
  const noStore = disabled || storageError; // save slots and the album need IndexedDB
  const pad = (b: string) => ({
    'data-pad': b,
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.classList.add('down');
      if (useSettingsStore.getState().haptics) navigator.vibrate?.(8);
      pressButton(BUTTON_NUMBERS[b]);
    },
    onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => { e.currentTarget.classList.remove('down'); releaseButton(BUTTON_NUMBERS[b]); },
    onPointerCancel: (e: React.PointerEvent<HTMLButtonElement>) => { e.currentTarget.classList.remove('down'); releaseButton(BUTTON_NUMBERS[b]); },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });

  return (
    <div ref={rootRef} className={`pl${manual ? '' : ' closed'}${idle ? ' idle' : ''}`} style={{ '--flood': ink } as CSSProperties}>
      <header className="pl-top">
        <Link className="back" to={paths.game(game.id)}>{I.back}<span className="lbl">Back</span></Link>
        <h1><Link to={paths.game(game.id)}><Title text={game.title} /></Link></h1>
        <span className={`tag ${savedJustNow || auto ? 'saved' : kind}`}>{status}</span>
        <div className="right">
          <span className={`pad${gamepad ? ' on' : ''}`}><i /><span>{gamepad ? 'Gamepad' : 'No gamepad'}</span></span>
          <button className="manual-btn" aria-expanded={manual} aria-controls="sheet" onClick={() => setManual(!manual)}>{I.book}<span>Manual</span></button>
        </div>
      </header>

      <div className="pl-body">
        <div className="stage">
          <div className={`rw${isRewinding ? ' on' : ''}`}>{I.rew}Rewinding<span className="meter"><i style={{ width: `${bufferFill * 100}%` }} /></span></div>
          <div className="screen" style={screenStyle}>
            <div className="frame">
              <canvas key={canvasKey} ref={canvasRef} className="lcd" width={800} height={720} aria-label={`${game.title} screen`} />
              {badRom ? (
                <div className="overlay">
                  <b>This file can’t be played</b>
                  <p>It’s damaged or isn’t a Game Boy ROM.</p>
                  <div className="acts">
                    {game.isLocal && <button className="btn y" onClick={async () => { await deleteGame(game.id); toast(`${game.title} removed`, 'm'); navigate('/'); }}>Remove from library</button>}
                    <Link className="btn line" to={paths.game(game.id)}>Back</Link>
                  </div>
                </div>
              ) : needsRom ? (
                <div className="overlay">
                  <b>Insert your ROM</b>
                  <p>{game.title} isn’t included. Load your own .gb file to play; it stays in this browser.</p>
                  <label className="btn y" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.querySelector('input')?.click(); } }}>
                    {I.cart}Load your ROM
                    <input type="file" accept=".gb,.gbc" className="sr" tabIndex={-1}
                      onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; const data = f && await linkRom(f); if (data) boot(data); }} />
                  </label>
                </div>
              ) : romLoaded && !isRunning && !isRewinding && (
                <div className="overlay"><b>Paused</b><p>Press P or the play button to continue.</p></div>
              )}
            </div>
          </div>
          <div className="cap">
            <span>{display.custom ? 'Custom' : presetOf(display.cfg.preset)!.label}</span><i /><span>{speed === 0.5 ? '½' : speed}× speed</span><i /><span>Rewind {Math.round(bufferFill * rewindSeconds)} s ready</span>
          </div>
        </div>

        <Manual
          game={game} header={header} inColor={inColor} tab={tab} onTab={setTab} romLoaded={romLoaded && !storageError} isRunning={isRunning}
          states={saves.states} shots={album.shots} emu={emu}
          onSave={(i) => (saves.states[i + 1]
            ? setConfirm({ title: `Overwrite slot ${i + 1}?`, body: `The save from ${ago(saves.states[i + 1]!.timestamp)} is replaced by the game as it is now.`, ok: 'Overwrite', run: () => saveSlot(i) })
            : saveSlot(i))}
          onLoad={loadSlot} onScreenshot={screenshot}
        />
      </div>

      <nav className="deck" aria-label="Playback">
        <button className="dk main" onClick={togglePlay} disabled={disabled} aria-label={isRunning ? 'Pause, P' : 'Play, P'}>
          {isRunning ? <>{I.pause}<span className="lbl">Pause</span></> : <>{I.play}<span className="lbl">Play</span></>}<span className="k">P</span>
        </button>
        <button className="dk" aria-label="Rewind, hold R" aria-pressed={isRewinding} disabled={disabled}
          onPointerDown={startRewind} onPointerUp={stopRewind} onPointerLeave={stopRewind} onPointerCancel={stopRewind}>
          {I.rew}<span className="lbl">Rewind</span><span className="k">Hold R</span>
        </button>
        <span className="gap" />
        <div className="speed" role="group" aria-label="Speed">
          {SPEEDS.map((s) => <button key={s} aria-pressed={speed === s} onClick={() => setSpeed(s)}>{s === 0.5 ? '½' : s}×</button>)}
        </div>
        <span className="gap" />
        <button className="dk" onClick={() => saveSlot(0)} disabled={noStore} aria-label="Save to slot 1, F5">{I.save}<span className="lbl">Save</span><span className="k">F5</span></button>
        <button className="dk hide-m" onClick={() => loadSlot(0)} disabled={noStore} aria-label="Load slot 1, F8">{I.load}<span className="lbl">Load</span><span className="k">F8</span></button>
        <button className="dk hide-m" onClick={screenshot} disabled={noStore} aria-label="Screenshot, F12">{I.cam}<span className="lbl">Photo</span><span className="k">F12</span></button>
        <span className="push" />
        <button className="dk hide-m" onClick={mute} aria-pressed={muted} aria-label="Mute, M">{muted ? I.mute : I.sound}</button>
        <button className="dk" onClick={toggleFullscreen} aria-label="Fullscreen, F">{I.full}</button>
      </nav>

      <div className="touch" data-size={touchSize} aria-label="Touch controls">
        <div className="dpad">
          <span className="c" />
          <button className="u" aria-label="Up" {...pad('Up')}>{I.up}</button>
          <button className="d" aria-label="Down" {...pad('Down')}>{I.down}</button>
          <button className="l" aria-label="Left" {...pad('Left')}>{I.left}</button>
          <button className="r" aria-label="Right" {...pad('Right')}>{I.right}</button>
        </div>
        <div className="ab"><button className="b" {...pad('B')}>B</button><button className="a" {...pad('A')}>A</button></div>
        <div className="ss"><button {...pad('Select')}>Select</button><button {...pad('Start')}>Start</button></div>
      </div>

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      <Toasts />
    </div>
  );
}
