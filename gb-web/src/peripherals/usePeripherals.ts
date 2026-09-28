import { useCallback, useEffect, useRef, useState } from 'react';
import type { Emulator } from 'gb-core';
import { addScreenshot } from '../lib/db';
import { useSettingsStore } from '../store/settingsStore';
import { toast } from '../components/shell/actions';
import { t } from '../i18n';
import { feed, paperRgba, parseJob, PAPER_W, type Paper } from './paper';
import { applySensitivity, keysToTilt, pickSource, stickToTilt, TILT_KEYS, type Tilt, type TiltSource } from './tilt';
import { rightStick } from '../hooks/useGamepad';
import { chord, isKey } from '../utils/keybindings';

/** A motion reading older than this: the sensor stopped (background tab, permission gone), the pad or keys take over. */
const MOTION_STALE_MS = 500;

type Rumble = typeof import('./rumble');
/**
 * A strip left open (no feed after its last job) is finished after this many emulated frames without a
 * new job: 30 s of game time. Sending one full buffer takes about 450 frames at 1×; counting frames, not
 * wall time, keeps a long print whole at ½× or across a pause.
 */
const OPEN_FRAMES = 1800;

export interface Printout extends Paper { id: number; /** rows of this strip already printed before the last job */ from: number; png?: Blob }

/**
 * The cartridge's extra hardware in solo play: the pocket camera, a Game Boy Printer on the serial
 * port, the rumble motor, the MBC7 accelerometer (tilt from TiltDock's motion, a pad's right stick or I/J/K/L). `tick(frames)` runs once per animation frame, after the frames it emulated
 * (0 on a display faster than the Game Boy, every other frame: the motor keeps its last state).
 */
export function usePeripherals(core: () => Emulator | null, power: number, gameId: string, onSaved: () => void, frameEl: () => HTMLElement | null) {
  const [paper, setPaper] = useState<Printout | null>(null);
  const hasRumble = useRef(false);
  const rumbleMod = useRef<Rumble | null>(null);
  const open = useRef<{ paper: Printout; idle: number } | null>(null);
  const hasTilt = useRef(false);
  // Motion: the latest screen-aligned reading and when it came; `offset` is what Recenter took as level.
  const tiltIn = useRef({ motion: null as Tilt | null, at: 0, offset: null as Tilt | null, keys: new Set<string>(), keyTilt: { x: 0, y: 0 }, last: 0 });
  const [tiltSource, setTiltSource] = useState<TiltSource>('keys');

  // A finished strip goes to the album (as printed, 1 px per dot), with a ×4 copy kept for Save/Share.
  const finish = useCallback(async (p: Printout) => {
    if (open.current?.paper.id === p.id) open.current = null;
    const [png, big] = await Promise.all([toPng(p.shades, 1), toPng(p.shades, 4)]);
    setPaper((cur) => (cur?.id === p.id ? { ...cur, done: true, png: big ?? undefined } : cur));
    if (!png) return;
    try {
      await addScreenshot({ gameId, png, timestamp: Date.now(), kind: 'print' });
      onSaved();
    } catch { toast(t('periph.printer.failed'), 'm'); }
  }, [gameId, onSaved]);
  const finishRef = useRef(finish);
  useEffect(() => { finishRef.current = finish; }, [finish]);

  useEffect(() => {
    const emu = core();
    if (!power || !emu) return; // again on every power-on: a restart builds a new console, printer unplugged
    emu.set_printer_connected(true);
    hasRumble.current = emu.has_rumble();
    hasTilt.current = emu.has_tilt();
    let untick: (() => void) | undefined;
    let gone = false;
    if (hasRumble.current) import('./rumble').then((m) => { if (gone) return; rumbleMod.current = m; untick = m.mountTicks(); });
    // I/J/K/L tilt, unless a Game Boy button is bound to the key (the button wins) or text is being typed.
    const keys = tiltIn.current.keys;
    const tiltKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (!(k in TILT_KEYS) || chord(e)) return null;
      if (Object.values(useSettingsStore.getState().keybindings).some((b) => isKey(b, e))) return null;
      return e.target instanceof Element && e.target.closest('input:not([type=range]):not([type=checkbox]),textarea,select,[contenteditable=true]') ? null : k;
    };
    const down = (e: KeyboardEvent) => { const k = tiltKey(e); if (k) keys.add(k); };
    const up = (e: KeyboardEvent) => keys.delete(e.key.toLowerCase());
    const clear = () => keys.clear();
    if (hasTilt.current) { window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', clear); }
    return () => {
      gone = true;
      untick?.();
      window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', clear);
      keys.clear();
      rumbleMod.current?.stopRumble(frameEl());
      // Leaving mid-print: what came out so far still goes to the album.
      const o = open.current;
      if (o) void finishRef.current(o.paper);
    };
  }, [power, core, frameEl]);

  const onJob = useCallback((raw: Uint8Array) => {
    const job = parseJob(raw);
    if (!job) return;
    const prev = open.current?.paper ?? null;
    const next = feed(prev, job);
    if (!next) return; // a paper feed with nothing on the tray
    const same = prev && !prev.done ? prev : null; // the job continues (or closes) the open strip
    const p: Printout = { ...next, id: same ? same.id : Date.now(), from: same ? same.rows : 0 };
    setPaper(p);
    if (p.done) { open.current = null; void finish(p); }
    else open.current = { paper: p, idle: 0 };
  }, [finish]);

  const tick = useCallback((frames: number) => {
    const emu = core();
    if (!emu) return;
    for (let raw = emu.printer_take_job(); raw.length; raw = emu.printer_take_job()) onJob(raw);
    const o = open.current;
    if (o && (o.idle += frames) > OPEN_FRAMES) void finish(o.paper);
    if (hasTilt.current) {
      const ti = tiltIn.current, now = performance.now();
      const dt = ti.last ? Math.min(100, now - ti.last) : 0;
      ti.last = now;
      ti.keyTilt = keysToTilt(ti.keys, ti.keyTilt, dt);
      const stick = rightStick();
      // A held tilt key beats a pad lying idle on the desk.
      const src = pickSource({ motion: !!ti.motion && now - ti.at < MOTION_STALE_MS, pad: !!stick && !ti.keys.size });
      const off = ti.offset ?? { x: 0, y: 0 };
      // A sensor gone quiet holds its last value until the pad or keys move.
      const raw = src === 'motion' ? { x: ti.motion!.x - off.x, y: ti.motion!.y - off.y } : src === 'pad' ? stickToTilt(...stick!) : ti.keyTilt;
      const t = applySensitivity(raw, useSettingsStore.getState().tiltSensitivity);
      emu.set_tilt(t.x, t.y);
      setTiltSource(src);
    }
    const r = rumbleMod.current;
    if (!r || !hasRumble.current) return;
    const s = useSettingsStore.getState();
    const level = emu.take_rumble();
    if (!s.rumble) r.stopRumble(frameEl());
    else if (frames) r.rumble(level, { intensity: s.rumbleIntensity, shake: s.rumbleShake, frame: frameEl() });
  }, [core, onJob, finish, frameEl]);
  /** Paused or left: the motor stops with the game. */
  const stop = useCallback(() => rumbleMod.current?.stopRumble(frameEl()), [frameEl]);

  const feedCamera = useCallback((frame: Uint8Array) => core()?.camera_set_frame(frame), [core]);
  /** TiltDock's screen-aligned motion reading (null: motion off); the first one after turning it on is taken as level. */
  const tiltMotion = useCallback((m: Tilt | null) => {
    const ti = tiltIn.current;
    ti.motion = m;
    ti.at = m ? performance.now() : 0;
    if (!m) ti.offset = null;
    else ti.offset ??= m;
  }, []);
  const recenter = useCallback(() => { const ti = tiltIn.current; if (ti.motion) ti.offset = ti.motion; }, []);
  const dismiss = useCallback(() => setPaper(null), []);

  // Read from the core on render: a camera cartridge stays one until the next ROM load (which bumps power).
  const camera = !!power && !!core()?.has_camera();
  const tilt = !!power && !!core()?.has_tilt();
  return { camera, tilt, tiltSource, tiltMotion, recenter, paper, dismiss, tick, stop, feedCamera };
}

async function toPng(shades: Uint8Array, scale: number): Promise<Blob | null> {
  const c = document.createElement('canvas');
  c.width = PAPER_W * scale;
  c.height = (shades.length / PAPER_W) * scale;
  c.getContext('2d')!.putImageData(new ImageData(paperRgba(shades, scale), c.width, c.height), 0, 0);
  return new Promise((r) => c.toBlob(r, 'image/png'));
}
