import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { GameEntry } from '../../types/game';
import { fetchRom, recordSession, useGameLibrary } from '../../hooks/useGameLibrary';
import { CONSOLE_COMPAT, CONSOLE_DMG, CONSOLE_SGB, useEmulator } from '../../hooks/useEmulator';
import { useAudio } from '../../hooks/useAudio';
import { stretch } from '../../audio/AudioEngine';
import { useGamepad } from '../../hooks/useGamepad';
import { padNav } from '../../hooks/useGamepadNav';
import { combine } from '../../lib/held';
import { useLcdShader } from '../../hooks/useLcdShader';
import { useRewind } from '../../hooks/useRewind';
import { useSaveData, warnSaveFailed } from '../../hooks/useSaveData';
import { useSaveStates, type SlotKey } from '../../hooks/useSaveStates';
import { useAnimationFrame } from '../../hooks/useAnimationFrame';
import { CHANNEL_KEYS, machineFor, paletteOf, useDisplay, useSettingsStore, type Machine } from '../../store/settingsStore';
import { parseRomHeader, sgbCartOf } from '../../lib/rom-utils';
import { presetOf } from '../../shaders/filters';
import { BUTTON_NUMBERS, chord, isKey, learn } from '../../utils/keybindings';
import { dpadAt, slide } from '../../lib/touch-slide';
import { getActiveProfileId, getSaveState, getSram, resumeStateId, type StoredSaveState } from '../../lib/db';
import { bootFrom, skipSilentResume } from '../../lib/boot-from';
import { STARTUP } from '../../lib/settings-clean';
import { ago, owned, paths, tagOf, touchOnly } from '../../lib/ui';
import { settled } from '../../lib/transitions';
import { take } from '../../lib/pace';
import { I } from '../icons';
import { Title } from '../library/Cover';
import { useInk } from '../../hooks/useInk';
import { NotFound } from '../shell/AppShell';
import { toast } from '../shell/actions';
import { FileButton } from '../shell/FileButton';
import { Toasts } from '../shell/Toasts';
import { ConfirmDialog, type ConfirmRequest } from '../shell/ConfirmDialog';
import { useAlbum, useLinkRom, useRomHeader } from '../../hooks/useGameExtras';
import { Manual, type Tab } from './Manual';
import { TouchControls } from './TouchControls';
import { useMedia } from './touch-dom';
import { fileAccept } from '../../lib/pwa';
import { holdGame } from '../../lib/play-lock';
import { useRaSession } from '../../hooks/useRaSession';
import { t as tNow, useT } from '../../i18n';
import { usePeripherals } from '../../peripherals/usePeripherals';

// Cartridge peripherals load only when a cartridge uses them.
const CameraDock = lazy(() => import('../../peripherals/CameraDock'));
const PrinterTray = lazy(() => import('../../peripherals/PrinterTray'));
import { useOnlineLink } from '../../lib/netlink/useOnlineLink';
import { LinkCap, LinkWait } from '../netlink/LinkHud';

const FPS = 4194304 / 70224; // 59.73 Hz, the Game Boy's real frame rate
/** By console number (see useEmulator): what to switch on for a state made there, and the name in its messages. */
const MADE_ON: Machine[] = ['dmg', 'dmg', 'gbc', 'sgb'];
const ON = ['Dmg', 'Gbc', 'Gbc', 'Sgb'] as const;
/** What a game is switched on with, from its settings and its cartridge. */
const machineOf = (data: Uint8Array, gameId: string) => machineFor(useSettingsStore.getState(), gameId, sgbCartOf(parseRomHeader(data)));
const SPEEDS = [0.5, 1, 2, 4];
/** Phones, upright or sideways: the Manual is a sheet over the controls, not a page beside the game (see index.css). */
const SHEET = '(max-width:900px),(orientation:landscape) and (max-height:500px)';
const sheetCovers = () => matchMedia(SHEET).matches;
/** What Enter and Space press when it has the focus (and, for a slider, what the arrows move). */
const CONTROL = 'button,a[href],summary,[role=tab],[role=button],label[tabindex],input[type=range]';
/** Text is being typed: a slider, a switch or a button keeping focus leaves the keys to the game (Enter: see `down`). */
const typing = () => {
  const el = document.activeElement as HTMLElement | null;
  if (el instanceof HTMLInputElement) return !/^(range|checkbox|radio|button|submit|reset|color|file|image)$/.test(el.type);
  return !!el && (/SELECT|TEXTAREA/.test(el.tagName) || el.isContentEditable);
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
  const [q, setQ] = useSearchParams();
  const { savedIds, storageError, deleteGame } = useGameLibrary();
  const navigate = useNavigate();
  const t = useT();
  const emu = useEmulator();
  const { isReady, isRunning, setIsRunning, romLoaded, isCgb, loadRom, runFrame, getAudioSamples, pressButton, releaseButton,
    errors, hasBatteryRam, exportSram, importSram, saveState, loadState, framebufferSnapshot, setTraceEnabled, getTrace,
    consoleNow, stateConsole, paletteNow, skipBoot, sgbBorder, sgbSnesMusic, power } = emu;
  // Keyboard, pad and touch each hold their own buttons: letting go on one keeps what another still holds.
  const input = useMemo(() => combine(pressButton, releaseButton), [pressButton, releaseButton]);
  const padPress = useCallback((b: number, p?: number) => input.press('pad', b, p), [input]);
  const padRelease = useCallback((b: number, p?: number) => input.release('pad', b, p), [input]);
  const keybindings = useSettingsStore((s) => s.keybindings);
  const rewindSeconds = useSettingsStore((s) => s.rewindBufferSeconds);
  const screenSize = useSettingsStore((s) => s.screenSize);
  const channelMutes = useSettingsStore((s) => s.channelMutes);
  const smoothMotion = useSettingsStore((s) => s.smoothMotion);
  const smoothMotionForce = useSettingsStore((s) => s.smoothMotionForce);
  const [speed, setSpeed] = useState(() => (q.get('online') ? 1 : useSettingsStore.getState().defaultSpeed));
  const [tab, setTab] = useState<Tab>(() => (q.get('tab') as Tab) || 'controls');
  // Open at start only where it sits beside the game (not on phones, upright or sideways: see index.css).
  const [manual, setManual] = useState(() => !!q.get('tab') || !sheetCovers());
  // There it covers the controls: the game waits under it, and plays on when it closes (see the effect after `play`).
  const manualRef = useRef(manual);
  useEffect(() => { manualRef.current = manual; }, [manual]);
  const heldBySheet = useRef(false);
  // Edit controls (from the manual, or Settings › Controls with ?edit=controls): the game waits meanwhile.
  const [editing, setEditing] = useState(() => q.get('edit') === 'controls');
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
  const onPrinted = useCallback(() => {
    album.reload();
    toast(tNow('periph.printer.added'), '', { label: tNow('player.toast.view'), target: '#mt-album', run: () => { setTab('album'); setManual(true); } });
  }, [album]);
  const frameEl = useCallback(() => rootRef.current?.querySelector<HTMLElement>('.screen .frame') ?? null, []);
  const periph = usePeripherals(emu.core, power, game.id, onPrinted, frameEl);

  // A cartridge the core runs in Game Boy Color mode keeps its own colours: DMG palettes never apply to it,
  // and it has its own default screen settings (the core decides, from header byte 0x143 bit 7).
  const inColor = romLoaded && isCgb;
  const display = useDisplay(inColor ? 'cgb' : 'dmg', game.id);
  const { canvasRef, canvasKey, renderFrame, setMotion, drawMotion, usesTrace, restores } = useLcdShader(display.cfg.filters, inColor);
  const { ensureStarted, feedSamples, muted, toggleMute } = useAudio(isRunning);
  const saveTo = useRef<string | null>(null); // the save profile played solo (the game's active one)

  // ---- the Super Game Boy border: drawn behind the screen once the game sent one ----
  const borderRef = useRef<HTMLCanvasElement>(null);
  const borderVersion = useRef(0);
  const [bordered, setBordered] = useState(false);
  const snesTold = useRef(false);
  const syncBorder = useCallback(() => {
    // Its music on the SNES sound chip, which isn't emulated: unless the player chose the Super Game Boy, the game
    // starts on the Game Boy from now on, with its sound (the Screen page offers the restart).
    if (!snesTold.current && sgbSnesMusic()) {
      snesTold.current = true;
      const s = useSettingsStore.getState();
      if (s.gameSgb[game.id] === undefined) {
        s.set({ gameSgb: { ...s.gameSgb, [game.id]: false }, snesMusic: { ...s.snesMusic, [game.id]: true } });
        toast(tNow('player.toast.snesMusic'), 'm', { label: tNow('player.tabs.screen'), target: '#mt-screen', run: () => { setTab('screen'); setManual(true); } });
      }
    }
    const b = sgbBorder(borderVersion.current);
    if (!b) return;
    borderVersion.current = b.version;
    setBordered(!!b.rgba);
    if (b.rgba) borderRef.current?.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(b.rgba), 256, 224), 0, 0);
  }, [sgbBorder, sgbSnesMusic, game.id]);

  // ---- the console: an original Game Boy cartridge runs on the Game Boy or, colourised, on the Game Boy Color; one with
  // Super Game Boy functions on the Super Game Boy ----
  const romData = useRef<Uint8Array | null>(null);
  const [running, setRunning] = useState<Machine | null>(null); // what the core was powered on with
  const switchOk = useRef(false); // only the resume at start-up may follow its state onto another console
  const refused = useRef(false); // the last load was a state from another console (already explained)
  const powerOn = useCallback((data: Uint8Array, c: Machine, animation: number) => {
    const sgb = c === 'sgb';
    if (!loadRom(data, { colorize: !sgb && c !== 'dmg', palette: sgb ? 0 : paletteOf(c), animation, sgb })) return false;
    romData.current = data;
    setRunning(c);
    syncBorder();
    return true;
  }, [loadRom, syncBorder]);
  const { coreRef } = emu;
  const peekRa = useCallback((a: number) => coreRef.current?.read_memory_ra(a) ?? 0, [coreRef]);
  const ra = useRaSession(power, () => romData.current, peekRa, game.title);
  const raJumped = ra.jumped, raFrame = ra.frame;

  // Every state load (slot, resume point, rewind step) draws its picture at once, paused or not, with no ghosting from before the jump.
  const loadAndShow = useCallback((data: Uint8Array, frame?: Uint8Array | Uint8ClampedArray) => {
    refused.current = false;
    const made = stateConsole(data);
    const now = consoleNow();
    // A Game Boy state also loads on the Super Game Boy (the same machine; the game sends its colours again).
    if (made !== now && MADE_ON[made] && !(made === CONSOLE_DMG && now === CONSOLE_SGB)) {
      if (!switchOk.current || !romData.current || !powerOn(romData.current, MADE_ON[made], 1)) {
        refused.current = true;
        toast(tNow(`player.toast.madeOn${ON[made]}`), 'm');
        return false;
      }
    }
    if (!loadState(data, frame)) return false;
    raJumped();
    // A colourised state brings back its own palette: the Screen page then offers a restart if the game's choice differs.
    if (consoleNow() === CONSOLE_COMPAT) { const p = paletteNow(); setRunning(p ? `gbc${p}` : 'gbc'); }
    syncBorder();
    const fb = framebufferSnapshot();
    if (fb) { renderFrame(new Uint8ClampedArray(fb.buffer, fb.byteOffset, fb.length), true); setLit(true); }
    return true;
  }, [loadState, framebufferSnapshot, renderFrame, stateConsole, consoleNow, powerOn, paletteNow, syncBorder, raJumped]);
  // A WebGL context given back after a loss (iOS, backgrounded app) starts blank: redraw the frame, even paused.
  useEffect(() => {
    const fb = restores && framebufferSnapshot();
    if (fb) renderFrame(new Uint8ClampedArray(fb.buffer, fb.byteOffset, fb.length), true);
  }, [restores, framebufferSnapshot, renderFrame]);
  const saves = useSaveStates(game.id, { ...emu, loadState: loadAndShow }, saveTo);
  /**
   * New game (from the game page, or the Saves page of the Manual): a moment to change one's mind and go back to the
   * game as it was, before the fresh start gets written over the resume point. The battery save goes back to the one
   * that game was played in (the resume point may be another profile's than the one now used for solo).
   */
  const { loadEntry } = saves;
  const offerUndo = useCallback((was: Pick<StoredSaveState, 'data' | 'timestamp' | 'profile'> & { thumbnail?: Uint8Array }) => {
    toast(tNow('player.restart.done'), 'm', { label: tNow('player.restart.undo'), run: async () => {
      switchOk.current = true;
      const ok = await loadEntry(was, 'auto');
      switchOk.current = false;
      if (ok === true) toast(tNow('player.restart.undone'), 'c');
    } });
  }, [loadEntry]);
  // Rewinding stops quietly at a restart onto another console.
  const rewindLoad = useCallback((data: Uint8Array, frame?: Uint8ClampedArray) => stateConsole(data) === consoleNow() && loadAndShow(data, frame), [stateConsole, consoleNow, loadAndShow]);
  const { isRewinding, startRewind, stopRewind, wrapRunFrame, bufferFill } = useRewind({ saveState, loadState: rewindLoad });
  const saveWriter = useSaveData({ saveTo, romLoaded, hasBatteryRam, exportSram });
  // Online link cable (?online=<room>): real time only, so no speed change, rewind or state loading while plugged in.
  const online = useOnlineLink(emu.coreRef, power, q.get('online'), isRunning);
  const linkPump = online.pump;

  // No Fullscreen API on iPhone (nor in its Home Screen apps): "immersive" hides the chrome instead and gives the screen all the room.
  const [immersive, setImmersive] = useState(false);
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenEnabled) setImmersive((v) => !v);
    else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    // Phones (Android): the player's own fullscreen layout has no touch controls. The whole page goes fullscreen
    // instead, in the immersive layout, which keeps them.
    else (sheetCovers() ? document.documentElement : rootRef.current)?.requestFullscreen().catch(() => {});
  }, []);
  // Left by Escape or the system as often as by the button: the button follows the browser.
  const [full, setFull] = useState<Element | null>(null);
  const pageFull = full === document.documentElement;
  useEffect(() => {
    const sync = () => setFull(document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  // The pad plays the game while it runs; paused, it works the Manual and the page (useGamepadNav).
  const { connected: gamepad } = useGamepad(padPress, padRelease, romLoaded && isRunning, toggleFullscreen);

  // Phones sideways: the top bar takes the row but the deck's width (see index.css).
  useLayoutEffect(() => {
    const root = rootRef.current, deck = root?.querySelector<HTMLElement>('.deck');
    if (!root || !deck) return;
    const ro = new ResizeObserver(() => root.style.setProperty('--deck-w', `${deck.offsetWidth}px`));
    ro.observe(deck);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { document.title = t('common.docTitle', { page: game.title }); }, [game.title, t]);
  // Sync in another tab leaves this game's saves alone while it's open (lib/play-lock).
  // A ROM the core refused never runs: nothing to protect (and its Remove button, below, must not see it as busy).
  useEffect(() => (badRom ? undefined : holdGame(game.id)), [game.id, badRom]);
  // Settings › Audio › Channels (applied again after each power-on: a restart builds a new console).
  const { setChannelMuted } = emu;
  useEffect(() => {
    if (power) CHANNEL_KEYS.forEach((k, i) => setChannelMuted(i, channelMutes[k]));
  }, [power, channelMutes, setChannelMuted]);
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

  // The console is on but its saves are still loading: not paused (the Paused card would flash for a few frames).
  const [booting, setBooting] = useState(false);
  /** Boot a ROM: cartridge save first, then the requested resume point or slot, then run. */
  const boot = useCallback(async (data: Uint8Array) => {
    setBooting(true);
    const s = useSettingsStore.getState();
    const slot = q.get('slot');
    const resume = await getSaveState(resumeStateId(game.id)).catch(() => undefined);
    let from: SlotKey | null = bootFrom(q, s.resumePoints, !!resume);
    // A slot is loaded once: a reload (or iOS bringing back an evicted tab) goes on from the resume point instead.
    if (slot !== null) setQ((p) => { p.delete('slot'); if (s.resumePoints) p.set('resume', '1'); return p; }, { replace: true });
    // New game: once. A reload goes on from the resume point (the old one until the new game writes over it).
    const fresh = q.has('new');
    if (fresh) setQ((p) => { p.delete('new'); return p; }, { replace: true });
    // A state replaces the start-up at once: an animation then costs nothing (and plays if the state is gone).
    const animation = STARTUP.indexOf(s.startupAnimation);
    if (!powerOn(data, machineOf(data, game.id), from !== null ? Math.max(animation, 1) : animation)) { setBadRom(true); setBooting(false); return; }
    setNeedsRom(false);
    // Moved to the Game Boy for its SNES music (see syncBorder): a resume point made on the Super Game Boy would bring the
    // silence back, so the game starts again on the Game Boy, from its cartridge save. "Resume there" still goes back to it.
    if (resume && skipSilentResume(from, MADE_ON[stateConsole(resume.data)], machineOf(data, game.id), !!s.snesMusic?.[game.id])) {
      from = null;
      if (animation <= 0) skipBoot();
      toast(tNow('player.toast.snesFresh'), 'm', { label: tNow('player.toast.resumeThere'), run: async () => {
        switchOk.current = true;
        const ok = await saves.load('auto');
        switchOk.current = false;
        if (ok === true) toast(tNow('player.toast.loadedResume'), 'c');
      } });
    }
    if (hasBatteryRam()) {
      const id = q.get('save') ?? await getActiveProfileId(game.id).catch(() => game.id);
      const sram = await getSram(id).catch(() => undefined);
      if (sram) importSram(sram.sram);
      saveTo.current = id;
      saveWriter.adopt(id, sram);
    }
    if (from !== null) {
      const before = consoleNow();
      switchOk.current = true;
      const r = await saves.load(from, true);
      const ok = r === true;
      switchOk.current = false;
      if (!ok && animation <= 0) skipBoot();
      const moved = ok && consoleNow() !== before;
      if (moved) toast(tNow(`player.toast.resumedOn${ON[consoleNow()] ?? 'Dmg'}`), 'm');
      else if (r === 'older') toast(tNow('player.toast.saveNewer'), 'm');
      else if (!refused.current) toast(ok ? (from === 'auto' ? tNow('player.toast.resumed') : tNow('player.toast.loadedSlot', { n: String(+from + 1) })) : tNow('player.toast.gone'), ok ? 'c' : 'm');
    }
    if (fresh && resume) offerUndo(resume);
    // Opened on a page of the Manual on a phone (Save slots from the library, say): the game waits until it closes.
    setBooting(false); // in the same render as the one that starts it running
    if (manualRef.current && sheetCovers()) heldBySheet.current = true;
    else setIsRunning(q.get('edit') !== 'controls');
  }, [powerOn, hasBatteryRam, importSram, game.id, q, setQ, saves, setIsRunning, consoleNow, skipBoot, saveWriter, stateConsole, offerUndo]);

  // A ROM that can't be fetched (a hosted game streamed while offline, say) keeps its reason on the screen, with a retry.
  const [loadError, setLoadError] = useState<string | null>(null);
  const start = useCallback(() => {
    fetchRom(game).then(boot).catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  }, [game, boot]);
  // The core itself failed to load: the same overlay, whose retry loads it again.
  const failure = emu.initFailed ? t('player.error.engine') : loadError;
  const booted = useRef(false);
  useEffect(() => {
    if (!isReady || booted.current || !owned(game)) return;
    booted.current = true;
    start();
  }, [isReady, game, start]);

  // ---- frame loop: real-time paced (60 Hz or 120 Hz screens alike), speed ½–4× ----
  const pace = useRef({ last: 0, acc: 0 });
  const played = useRef(0); // seconds actually emulated this session
  const dirty = useRef(false); // something ran since the last resume point
  const speedRef = useRef(speed);
  useEffect(() => { speedRef.current = speed; }, [speed]);
  const { tick: periphTick, stop: periphStop } = periph;
  const runOne = useCallback(() => {
    const fb = runFrame();
    if (fb) raFrame();
    linkPump();
    const samples = getAudioSamples(); // always drained; only played at ≤ 1× (stretched to fill the device at ½×)
    if (samples && speedRef.current <= 1) feedSamples(stretch(samples, speedRef.current));
    return fb;
  }, [runFrame, getAudioSamples, feedSamples, linkPump, raFrame]);
  // Display refresh rate, from the time between animation frames (median of the last 31).
  const refresh = useRef<number[]>([]);
  const onFrame = useCallback(() => {
    const now = performance.now();
    const p = pace.current;
    const dt = p.last ? Math.min(0.1, (now - p.last) / 1000) : 1 / FPS;
    if (p.last) { refresh.current.push(dt); if (refresh.current.length > 31) refresh.current.shift(); }
    p.last = now;
    p.acc += dt * FPS * speedRef.current;
    let n: number;
    [n, p.acc] = take(p.acc, 8);
    if (isRewinding) n = 1; // rewind runs at its own pace, whatever the speed
    // Smooth motion only where it makes sense: a display faster than the Game Boy (or forced), normal speed, no rewind.
    const hz = refresh.current.length >= 15 ? 1 / [...refresh.current].sort((a, b) => a - b)[refresh.current.length >> 1] : 60;
    const motion = smoothMotion && (smoothMotionForce || hz > 75) && speedRef.current === 1 && !isRewinding;
    setMotion(motion);
    // Only while Neural 4× really runs its tile path, or Smooth motion is on. Never on the Super Game Boy: the trace
    // has the Game Boy's shades, not the picture's colours (Neural 4× then works from the picture alone, motion rests).
    const traced = usesTrace() && consoleNow() !== CONSOLE_SGB;
    setTraceEnabled(traced);
    let fb: Uint8ClampedArray | null = null;
    for (let i = 0; i < n; i++) fb = wrapRunFrame(runOne) ?? fb;
    const trace = fb && traced && !isRewinding ? getTrace() : null; // a rewound frame has no trace of its own
    if (fb) { renderFrame(fb, false, trace, p.acc); setLit(true); syncBorder(); }
    else if (motion) drawMotion(p.acc);
    // Online, the resume point stays the solo game's: a mid-link state is no place to come back to alone.
    if (n) { played.current += dt; if (!online.on) dirty.current = true; }
    periphTick(isRewinding ? 0 : n);
  }, [wrapRunFrame, runOne, renderFrame, isRewinding, smoothMotion, smoothMotionForce, setTraceEnabled, getTrace, setMotion, drawMotion, usesTrace, periphTick, online.on, consoleNow, syncBorder]);
  const looping = romLoaded && (isRunning || isRewinding);
  useEffect(() => { if (!looping) { pace.current.last = 0; refresh.current = []; periphStop(); } }, [looping, periphStop]);
  useAnimationFrame(onFrame, looping);

  // ---- resume point + play time, written when leaving (route change, tab hidden, page closed) ----
  const saveAuto = saves.save;
  // Play time is flushed with every resume-point save (not only on leave): a pagehide write
  // can be cut off by the unload, so a reload or closed tab would otherwise lose the session.
  const sessionCounted = useRef(false);
  useEffect(() => { sessionCounted.current = false; }, [game.id]);
  /** Resolves true once a resume point was written (false: nothing to write, or it failed and the player was told). */
  const leave = useCallback((): Promise<boolean> => {
    let wrote = Promise.resolve(false);
    if (dirty.current && useSettingsStore.getState().resumePoints) {
      dirty.current = false;
      // A failed write leaves it dirty: the next leave tries again.
      wrote = saveAuto('auto').then((ok) => { if (!ok) dirty.current = true; return ok; });
    }
    const seconds = Math.floor(played.current);
    if (seconds >= 1) {
      played.current -= seconds;
      recordSession(game.id, seconds, !sessionCounted.current).catch(() => {}); // storage blocked: play time isn't kept
      sessionCounted.current = true;
    }
    return wrote;
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
    window.addEventListener('beforeunload', onPageHide); // WebKit drops a write from pagehide on reload or close
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
      // Told only once it is stored: a failed write shows its own warning instead.
      leaveRef.current().then((ok) => { if (ok) toast(tNow('player.toast.resumeSaved', { title: game.title }), 'm'); });
    };
  }, [game.title]);

  // ---- actions ----
  const play = useCallback(() => { ensureStarted(true).catch(() => {}); setIsRunning(true); }, [ensureStarted, setIsRunning]);
  // The game waits while its controls are edited, and plays again when they're done.
  const editControls = useCallback(() => { setManual(false); setIsRunning(false); setEditing(true); }, [setIsRunning]);
  // Playing from under the phone sheet closes it first (the sheet effect below would pause the game straight away).
  const togglePlay = useCallback(() => {
    if (isRunning) return setIsRunning(false);
    if (sheetCovers()) setManual(false);
    play();
  }, [isRunning, setIsRunning, play]);
  // Phones: nobody plays a game under the Manual (the sheet hides the controls), and it must not run on its own there
  // and write over the resume point. It pauses while the sheet is open, and plays on when it closes if it was running.
  // A tablet turned upright with the Manual open beside the game gets the sheet: the same then.
  const covers = useMedia(SHEET);
  useEffect(() => {
    if (manual && isRunning && covers) { heldBySheet.current = true; setIsRunning(false); }
    else if ((!manual || !covers) && heldBySheet.current) { heldBySheet.current = false; if (!editing) play(); }
  }, [manual, covers, isRunning, editing, play, setIsRunning]);
  /** Switch the console off and on with the game's chosen one: the battery save carries over, like the cartridge. */
  const restart = useCallback(() => {
    const data = romData.current;
    if (!data) return;
    const sram = hasBatteryRam() ? exportSram() : null;
    if (!powerOn(data, machineOf(data, game.id), STARTUP.indexOf(useSettingsStore.getState().startupAnimation))) return;
    if (sram) importSram(sram);
    play();
  }, [hasBatteryRam, exportSram, importSram, powerOn, game.id, play]);
  /** New game from the Manual: the game as it was stays one tap away. */
  const startOver = useCallback(() => {
    // Copies: the power-on reuses the WASM memory these view.
    const was = romLoaded ? saveState() : null, fb = romLoaded ? framebufferSnapshot() : null;
    const data = was && new Uint8Array(was), frame = fb ? new Uint8Array(fb) : undefined;
    const profile = saveTo.current ?? undefined;
    restart();
    if (data) offerUndo({ data, thumbnail: frame, timestamp: Date.now(), profile });
  }, [romLoaded, saveState, framebufferSnapshot, restart, offerUndo]);
  const saveSlot = useCallback(async (i: number) => {
    const was = saves.states[i + 1]; // F5 and the deck's Save write over slot 1 without asking: one tap puts it back
    if (!romLoaded || !(await saves.save(i))) return;
    setSavedJustNow(true);
    const n = String(i + 1);
    toast(tNow('player.toast.saved', { n }), 'm', was && { label: tNow('player.restart.undo'), run: async () => {
      if (!(await saves.put(was))) return;
      setSavedJustNow(false);
      toast(tNow('player.toast.slotBack', { n }), 'c');
    } });
  }, [romLoaded, saves]);
  const loadSlot = useCallback(async (k: SlotKey) => {
    if (!romLoaded) return;
    if (await saves.load(k)) toast(k === 'auto' ? tNow('player.toast.loadedResume') : tNow('player.toast.loadedSlot', { n: String(k + 1) }), 'c');
    else if (!refused.current) toast(k === 'auto' ? tNow('player.toast.noResume') : tNow('player.toast.emptySlot', { n: String(k + 1) }), 'm');
  }, [romLoaded, saves]);
  const screenshot = useCallback(async () => {
    const rgba = romLoaded && framebufferSnapshot();
    if (!rgba) return;
    // A full device must say so, like a save slot: the player would go on trusting the album.
    try { await album.add(rgba); } catch (e) { warnSaveFailed(e); return; }
    toast(tNow('player.toast.shot'), '', { label: tNow('player.toast.view'), target: '#mt-album', run: () => { setTab('album'); setManual(true); } });
  }, [romLoaded, framebufferSnapshot, album]);
  const mute = useCallback(() => { toggleMute(); toast(muted ? tNow('player.toast.soundOn') : tNow('player.toast.soundOff'), 'c'); }, [toggleMute, muted]);

  // ---- keyboard: game buttons from Settings, then player shortcuts ----
  const noop = () => {};
  const rewind = online.on ? noop : startRewind, load = online.on ? async () => {} : loadSlot;
  const actions = useRef({ togglePlay, saveSlot, loadSlot: load, screenshot, mute, toggleFullscreen, startRewind: rewind, stopRewind });
  useEffect(() => { actions.current = { togglePlay, saveSlot, loadSlot: load, screenshot, mute, toggleFullscreen, startRewind: rewind, stopRewind }; });
  // The pad's menu button (Home, or Select + Start): pause and open the Manual, or play on. Not while the touch layout
  // is edited: the game waits under the editor (as P does, see `down`).
  useEffect(() => {
    padNav.game = romLoaded && isRunning;
    padNav.menu = romLoaded && !editing ? () => { if (isRunning) setManual(true); actions.current.togglePlay(); } : undefined;
    return () => { padNav.game = false; padNav.menu = undefined; };
  }, [romLoaded, isRunning, editing]);
  // Each finger holds what's under it: a thumb rolls across the D-pad (diagonals on the way) or from B onto A.
  const held = useRef(new Map<number, string[]>());
  useEffect(() => {
    // By physical key: Select (Shift) held doesn't turn the 1 bound to A into a '!' that matches nothing.
    const buttonOf = (e: KeyboardEvent) => {
      for (const [b, k] of Object.entries(keybindings)) if (isKey(k, e)) return BUTTON_NUMBERS[b];
      return undefined;
    };
    // The control last focused by a click or a tap (a focus moved on by Tab or the pad forgets it).
    let clicked: Element | null = null;
    // The button each physical key pressed: its keyup can carry another `key` (Shift pressed or let go meanwhile: '1' comes up as '!').
    const pressed = new Map<string, number>();
    const onPointer = (e: PointerEvent) => { clicked = e.target instanceof Element ? e.target.closest(CONTROL) : null; };
    const onFocus = (e: FocusEvent) => { if (e.target !== clicked) clicked = null; };
    const down = (e: KeyboardEvent) => {
      // The touch layout editor has the page (arrows and +/- move its parts): the game waits, no shortcut gets through.
      if (editing || typing() || document.querySelector('dialog[open]') || chord(e)) return;
      // Keys on the camera lens or the printer tray work their own controls (Enter presses the button, not Start).
      if (e.target instanceof Element && e.target.closest('.cdock,.ptray')) return;
      // Enter or Space on a control reached with the keyboard presses it; after a click, the keys stay the game's.
      const control = (e.key === 'Enter' || e.key === ' ') && e.target instanceof Element ? e.target.closest(CONTROL) : null;
      if (control && control !== clicked) return;
      // Likewise the arrows (Home, End, Page Up/Down) move a slider reached with the keyboard.
      const slider = /^(Arrow|Home$|End$|Page)/.test(e.key) && e.target instanceof HTMLInputElement && e.target.type === 'range' ? e.target : null;
      if (slider && slider !== clicked) return;
      const a = actions.current;
      const b = buttonOf(e);
      if (b !== undefined) {
        e.preventDefault();
        if (e.repeat) return;
        pressed.set(e.code, b); input.press('key', b);
        // A key saved as its character learns its physical key from this press (and then plays with Shift held too).
        const learnt = learn(keybindings, e);
        if (learnt) useSettingsStore.setState({ keybindings: learnt });
        return;
      }
      const k = e.key.toLowerCase();
      const run = { f5: () => a.saveSlot(0), f8: () => a.loadSlot(0), f12: a.screenshot, p: a.togglePlay, m: a.mute, f: a.toggleFullscreen, r: a.startRewind }[k];
      if (!run) return;
      e.preventDefault();
      if (!e.repeat) run();
    };
    const up = (e: KeyboardEvent) => {
      const b = pressed.get(e.code) ?? buttonOf(e);
      pressed.delete(e.code);
      if (b !== undefined) input.release('key', b);
      else if (e.key.toLowerCase() === 'r') actions.current.stopRewind();
    };
    // A key or a finger let go in another window never comes back: let go of theirs when the page loses focus. A pad's
    // buttons stay, its next poll reads them again.
    const releaseAll = () => {
      pressed.clear(); input.clear('key'); actions.current.stopRewind();
      // The fingers' buttons are drawn up too, not only let go (a finger still down presses again as it moves).
      held.current.clear(); input.clear('touch');
      document.querySelectorAll('.touch [data-pad].down').forEach((el) => el.classList.remove('down'));
    };
    const onHidden = () => { if (document.visibilityState === 'hidden') releaseAll(); };
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('focusin', onFocus, true);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true); window.removeEventListener('focusin', onFocus, true);
      window.removeEventListener('keydown', down); window.removeEventListener('keyup', up);
      window.removeEventListener('blur', releaseAll); document.removeEventListener('visibilitychange', onHidden);
    };
  }, [keybindings, input, editing]);

  /** Confirm, then start over with an undo (the Saves page and the pause card). */
  const askStartOver = () => setConfirm({ title: t('player.restart.title'), body: t('player.restart.body'), danger: true, ok: t('player.restart.ok'), run: startOver });
  const auto = saves.states[0];
  const [kind, label] = tagOf(game, savedIds);
  const status = needsRom ? label : savedJustNow ? t('player.savedNow') : auto ? t('player.resumeAgo', { ago: ago(auto.timestamp) }) : label;
  // A fixed size (2×–4×) is the most the screen takes: the CSS still shrinks it to the room there is.
  const screenStyle = screenSize === 'fit' ? undefined : { '--sw': `${(bordered ? 256 : 160) * +screenSize + 24}px` } as CSSProperties;
  const disabled = !romLoaded;
  const noStore = disabled || storageError; // save slots and the album need IndexedDB
  const hold = (e: React.PointerEvent<HTMLElement>, now: string[]) => {
    const root = e.currentTarget.closest('.touch');
    const { press, release } = slide(held.current, e.pointerId, now);
    for (const b of release) { root?.querySelector(`[data-pad="${b}"]`)?.classList.remove('down'); input.release('touch', BUTTON_NUMBERS[b]); }
    for (const b of press) { root?.querySelector(`[data-pad="${b}"]`)?.classList.add('down'); input.press('touch', BUTTON_NUMBERS[b]); }
    if (press.length && useSettingsStore.getState().haptics) navigator.vibrate?.(8);
  };
  const letGo = (e: React.PointerEvent<HTMLElement>) => hold(e, []);
  /** The D-pad directions under the pointer, or null off the pad: the whole box is one control (centre and corners too). */
  const onDpad = (e: React.PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.closest('.touch')?.querySelector('.dpad')?.getBoundingClientRect();
    if (!r || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return null;
    return dpadAt(e.clientX - (r.left + r.right) / 2, e.clientY - (r.top + r.bottom) / 2, r.width);
  };
  /** `b`: one button; 'dpad': the D-pad box, which reads the directions from where the thumb is. */
  const handlers = (b: string) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      // An armed rumble tick (iPhone, see peripherals/rumble.ts) needs the tap to reach its switch: no preventDefault then.
      const tick = e.target instanceof Element && !!e.target.closest('.rtick')?.querySelector('input:enabled');
      if (!tick) e.preventDefault();
      // Capture can throw (pointer already released or cancelled by the system): never lose the press over it.
      if (!tick) try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* keep going */ }
      hold(e, b === 'dpad' ? onDpad(e) ?? [] : [b]);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      const dirs = onDpad(e);
      if (dirs) { hold(e, dirs); return; }
      // Over another button: that one. Over nothing: the thumb keeps what it holds (it overshoots the edges).
      const root = e.currentTarget.closest('.touch');
      const other = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-pad]');
      if (other?.dataset.pad && root?.contains(other)) hold(e, [other.dataset.pad]);
    },
    onPointerUp: letGo,
    onPointerCancel: letGo,
    // Uncaptured (an armed rumble tick): sliding off the button lets it go.
    onPointerLeave: (e: React.PointerEvent<HTMLElement>) => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) letGo(e); },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  });
  const pad = (b: string) => (b === 'dpad' ? handlers(b) : { 'data-pad': b, ...handlers(b) });

  return (
    <div ref={rootRef} className={`pl${manual ? '' : ' closed'}${idle ? ' idle' : ''}${immersive || pageFull ? ' imm' : ''}${bordered ? ' sgb' : ''}`} style={{ '--flood': ink } as CSSProperties}>
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
        <main className="stage" style={screenStyle}>
          <div className={`rw${isRewinding ? ' on' : ''}`}>{I.rew}{t('player.rewinding')}<span className="meter"><i style={{ width: `${bufferFill * 100}%` }} /></span></div>
          <div className="screen">
            <div className="frame">
              <canvas ref={borderRef} className="sgb-border" width={256} height={224} hidden={!bordered} aria-hidden="true" />
              <canvas key={canvasKey} ref={canvasRef} className={`lcd${lit ? ' lit' : ''}`} width={800} height={720} aria-label={t('player.screenOf', { title: game.title })} />
              {badRom ? (
                <div className="overlay">
                  <b>{t('player.bad.title')}</b>
                  <p>{t('player.bad.body')}</p>
                  <div className="acts">
                    {game.isLocal && <button className="btn y" onClick={async () => { if (!(await deleteGame(game.id))) return toast(tNow('game.openElsewhere'), 'm'); toast(tNow('game.removed', { title: game.title }), 'm'); navigate('/'); }}>{t('player.bad.remove')}</button>}
                    <Link className="btn line" to={paths.game(game.id)}>{t('common.back')}</Link>
                  </div>
                </div>
              ) : failure ? (
                <div className="overlay slim" role="alert">
                  <b>{t('player.failed.title')}</b>
                  <p>{failure.charAt(0).toLocaleUpperCase() + failure.slice(1)}.{loadError && game.madeWith && !game.isLocal && <> {t('player.failed.hosted')}</>}</p>
                  <button className="btn y" onClick={() => { if (emu.initFailed) { emu.retryInit(); return; } setLoadError(null); start(); }}>{t('player.failed.retry')}</button>
                </div>
              ) : needsRom ? (
                <div className="overlay">
                  <b>{t('player.insert.title')}</b>
                  <p>{t('player.insert.body', { title: game.title })}</p>
                  <FileButton className="btn y" accept={fileAccept('.gb,.gbc,.zip')}
                    onFiles={async ([f]) => { const data = await linkRom(f); if (data) boot(data); }}>{I.cart}{t('game.loadRom')}</FileButton>
                </div>
              ) : online.on && online.waiting && isRunning ? <LinkWait link={online} /> : romLoaded && !booting && !isRunning && !isRewinding && !editing && (errors.at(-1)?.detail ? (
                <div className="overlay">
                  <b>{t('player.crashed.title')}</b>
                  <p>{t('player.crashed.body')}</p>
                  <p><small lang="en">{errors.at(-1)!.detail}</small></p>
                  <div className="acts"><button className="btn y" onClick={restart}>{t('player.crashed.restart')}</button></div>
                </div>
              ) : (
                <div className="overlay hold">
                  <b>{t('player.paused')}</b>{!touchOnly() && <p>{t('player.pausedSub')}</p>}
                  {/* Paused is where a player looks for "start over"; the Saves page has it too. */}
                  <div className="acts">
                    <button className="btn y" onClick={togglePlay}>{I.play}{t('player.resume')}</button>
                    {!online.on && <button className="btn line" onClick={askStartOver}>{t('player.restart.label')}</button>}
                  </div>
                </div>
              ))}
            </div>
          </div>
          {(periph.camera || periph.paper) && (
            <div className="periph">
              <Suspense fallback={null}>
                {periph.camera && <CameraDock feed={periph.feedCamera} running={isRunning} />}
                {periph.paper && <PrinterTray paper={periph.paper} gameId={game.id} title={game.title} onClose={periph.dismiss} />}
              </Suspense>
            </div>
          )}
          <div className="cap">
            <span>{display.custom ? t('settings.screen.custom') : t(`settings.screen.presets.${presetOf(display.cfg.preset)!.name}.label`)}</span><i /><span>{t('player.speed', { x: speed === 0.5 ? '½' : String(speed) })}</span><i />{online.on ? <LinkCap link={online} /> : <span>{t('player.rewindReady', { s: String(Math.round(bufferFill * rewindSeconds)) })}</span>}
          </div>
        </main>

        <Manual
          game={game} header={header} inColor={inColor} tab={tab} onTab={setTab} romLoaded={romLoaded && !storageError} isRunning={isRunning}
          states={saves.states} shots={album.shots} emu={emu}
          onSave={(i) => (saves.states[i + 1]
            ? setConfirm({ title: t('player.overwrite.title', { n: String(i + 1) }), body: t('player.overwrite.body', { ago: ago(saves.states[i + 1]!.timestamp) }), danger: true, ok: t('player.overwrite.ok'), run: () => saveSlot(i) })
            : saveSlot(i))}
          onLoad={load} onScreenshot={screenshot} online={online.on} running={running} onRestart={restart}
          onStartOver={askStartOver}
          onEditControls={editControls}
        />
      </div>

      <nav className="deck" aria-label={t('player.deck.label')}>
        <button className="dk main" onClick={togglePlay} disabled={disabled} aria-label={isRunning ? t('player.deck.pauseP') : t('player.deck.playP')}>
          {isRunning ? <>{I.pause}<span className="lbl">{t('player.deck.pause')}</span></> : <>{I.play}<span className="lbl">{t('library.hero.play')}</span></>}<span className="k">P</span>
        </button>
        <button className="dk" aria-label={t('player.deck.rewindR')} aria-pressed={isRewinding} disabled={disabled || online.on}
          onPointerDown={startRewind} onPointerUp={stopRewind} onPointerLeave={stopRewind} onPointerCancel={stopRewind}>
          {I.rew}<span className="lbl">{t('player.deck.rewind')}</span><span className="k">{t('player.deck.holdR')}</span>
        </button>
        <span className="gap" />
        {/* Online link cable: real time only, the speed controls give their room to the rest of the dock. */}
        {!online.on && <>
          <div className="speed" role="group" aria-label={t('player.deck.speed')}>
            {SPEEDS.map((s) => <button key={s} aria-pressed={speed === s} onClick={() => setSpeed(s)}>{s === 0.5 ? '½' : s}×</button>)}
          </div>
          {/* Narrow phones: one button steps through the speeds (the group doesn't fit). */}
          <button className="dk spd" onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])} aria-label={t('player.deck.speedChange', { x: speed })}>{speed === 0.5 ? '½' : speed}×</button>
          <span className="gap" />
        </>}
        <button className="dk" onClick={() => saveSlot(0)} disabled={noStore} aria-label={t('player.deck.saveF5')}>{I.save}<span className="lbl">{t('common.save')}</span><span className="k">F5</span></button>
        <button className="dk hide-m" onClick={() => loadSlot(0)} disabled={noStore || online.on} aria-label={t('player.deck.loadF8')}>{I.load}<span className="lbl">{t('common.load')}</span><span className="k">F8</span></button>
        <button className="dk hide-m" onClick={screenshot} disabled={noStore} aria-label={t('player.deck.shotF12')}>{I.cam}<span className="lbl">{t('player.deck.photo')}</span><span className="k">F12</span></button>
        <span className="push" />
        <button className="dk hide-m" onClick={mute} aria-pressed={muted} aria-label={t('player.deck.muteM')}>{muted ? I.mute : I.sound}</button>
        {document.fullscreenEnabled
          ? <button className="dk fs" onClick={toggleFullscreen} aria-pressed={!!full} aria-label={full ? t('player.deck.leaveFullF') : t('player.deck.fullF')}>{full ? I.close : I.full}</button>
          : <button className="dk fs" onClick={toggleFullscreen} aria-pressed={immersive} aria-label={immersive ? t('player.deck.leaveImmF') : t('player.deck.immF')}>{immersive ? I.close : I.full}</button>}
      </nav>

      <TouchControls pad={pad} online={online.on} editing={editing} onEdit={editControls}
        onDone={() => { setEditing(false); if (q.get('edit')) setQ({}, { replace: true }); if (!needsRom) play(); }}
        startRewind={startRewind} stopRewind={stopRewind} speed={speed} setSpeed={setSpeed} />

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      <Toasts />
    </div>
  );
}
