import { useCallback, useEffect, useRef, useState } from 'react';
import type { Emulator } from 'gb-core';
import { addScreenshot } from '../lib/db';
import { useSettingsStore } from '../store/settingsStore';
import { toast } from '../components/shell/actions';
import { feed, paperRgba, parseJob, PAPER_W, type Paper } from './paper';

type Rumble = typeof import('./rumble');
/** A strip left open (no feed after its last job) is finished after this long without a new job. */
const OPEN_MS = 3000;

export interface Printout extends Paper { id: number; /** rows of this strip already printed before the last job */ from: number; png?: Blob }

/**
 * The cartridge's extra hardware in solo play: the pocket camera, a Game Boy Printer on the serial
 * port, the rumble motor. `tick(frames)` runs once per animation frame, after the frames it emulated
 * (0 on a display faster than the Game Boy, every other frame: the motor keeps its last state).
 */
export function usePeripherals(core: () => Emulator | null, romLoaded: boolean, gameId: string, onSaved: () => void, frameEl: () => HTMLElement | null) {
  const [paper, setPaper] = useState<Printout | null>(null);
  const hasRumble = useRef(false);
  const rumbleMod = useRef<Rumble | null>(null);
  const open = useRef<{ paper: Printout; timer: number } | null>(null);

  useEffect(() => {
    const emu = core();
    if (!romLoaded || !emu) return;
    emu.set_printer_connected(true);
    hasRumble.current = emu.has_rumble();
    if (hasRumble.current) import('./rumble').then((m) => { rumbleMod.current = m; });
    return () => { rumbleMod.current?.stopRumble(frameEl()); };
  }, [romLoaded, core, frameEl]);

  // A finished strip goes to the album (as printed, 1 px per dot), with a ×4 copy kept for Save/Share.
  const finish = useCallback(async (p: Printout) => {
    const o = open.current;
    if (o?.paper.id === p.id) { clearTimeout(o.timer); open.current = null; }
    const [png, big] = await Promise.all([toPng(p.shades, 1), toPng(p.shades, 4)]);
    setPaper((cur) => (cur?.id === p.id ? { ...cur, done: true, png: big ?? undefined } : cur));
    if (!png) return;
    try {
      await addScreenshot({ gameId, png, timestamp: Date.now(), kind: 'print' });
      onSaved();
    } catch { toast('The print couldn’t be kept: storage is unavailable', 'm'); }
  }, [gameId, onSaved]);

  const onJob = useCallback((raw: Uint8Array) => {
    const job = parseJob(raw);
    if (!job) return;
    const prev = open.current?.paper ?? null;
    if (prev) clearTimeout(open.current!.timer);
    const next = feed(prev, job);
    const p: Printout = { ...next, id: prev && !prev.done ? prev.id : Date.now(), from: prev && !prev.done ? prev.rows : 0, done: false };
    setPaper(p);
    if (next.done) { open.current = null; void finish(p); }
    else open.current = { paper: p, timer: window.setTimeout(() => void finish(p), OPEN_MS) };
  }, [finish]);

  const tick = useCallback((frames: number) => {
    const emu = core();
    if (!emu) return;
    for (let raw = emu.printer_take_job(); raw.length; raw = emu.printer_take_job()) onJob(raw);
    const r = rumbleMod.current;
    if (!r || !hasRumble.current) return;
    const s = useSettingsStore.getState();
    const level = emu.take_rumble();
    if (!s.rumble) r.stopRumble(frameEl());
    else if (frames) r.rumble(level, { intensity: s.rumbleIntensity, shake: s.rumbleShake, frame: frameEl() });
  }, [core, onJob, frameEl]);
  /** Paused or left: the motor stops with the game. */
  const stop = useCallback(() => rumbleMod.current?.stopRumble(frameEl()), [frameEl]);

  const feedCamera = useCallback((frame: Uint8Array) => core()?.camera_set_frame(frame), [core]);
  const touch = useCallback(() => rumbleMod.current?.rumbleTouch(), []);
  const dismiss = useCallback(() => setPaper(null), []);

  // Read from the core on render: a camera cartridge stays one until the next ROM load (which flips romLoaded).
  const camera = romLoaded && !!core()?.has_camera();
  return { camera, paper, dismiss, tick, stop, feedCamera, touch };
}

async function toPng(shades: Uint8Array, scale: number): Promise<Blob | null> {
  const c = document.createElement('canvas');
  c.width = PAPER_W * scale;
  c.height = (shades.length / PAPER_W) * scale;
  c.getContext('2d')!.putImageData(new ImageData(paperRgba(shades, scale), c.width, c.height), 0, 0);
  return new Promise((r) => c.toBlob(r, 'image/png'));
}
