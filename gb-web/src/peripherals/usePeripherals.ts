import { useCallback, useEffect, useRef, useState } from 'react';
import type { Emulator } from 'gb-core';
import { addScreenshot } from '../lib/db';
import { useSettingsStore } from '../store/settingsStore';
import { toast } from '../components/shell/actions';
import { t } from '../i18n';
import { feed, paperRgba, parseJob, PAPER_W, type Paper } from './paper';

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
 * port, the rumble motor. `tick(frames)` runs once per animation frame, after the frames it emulated
 * (0 on a display faster than the Game Boy, every other frame: the motor keeps its last state).
 */
export function usePeripherals(core: () => Emulator | null, romLoaded: boolean, gameId: string, onSaved: () => void, frameEl: () => HTMLElement | null) {
  const [paper, setPaper] = useState<Printout | null>(null);
  const hasRumble = useRef(false);
  const rumbleMod = useRef<Rumble | null>(null);
  const open = useRef<{ paper: Printout; idle: number } | null>(null);

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
    if (!romLoaded || !emu) return;
    emu.set_printer_connected(true);
    hasRumble.current = emu.has_rumble();
    let untick: (() => void) | undefined;
    let gone = false;
    if (hasRumble.current) import('./rumble').then((m) => { if (gone) return; rumbleMod.current = m; untick = m.mountTicks(); });
    return () => {
      gone = true;
      untick?.();
      rumbleMod.current?.stopRumble(frameEl());
      // Leaving mid-print: what came out so far still goes to the album.
      const o = open.current;
      if (o) void finishRef.current(o.paper);
    };
  }, [romLoaded, core, frameEl]);

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
  const dismiss = useCallback(() => setPaper(null), []);

  // Read from the core on render: a camera cartridge stays one until the next ROM load (which flips romLoaded).
  const camera = romLoaded && !!core()?.has_camera();
  return { camera, paper, dismiss, tick, stop, feedCamera };
}

async function toPng(shades: Uint8Array, scale: number): Promise<Blob | null> {
  const c = document.createElement('canvas');
  c.width = PAPER_W * scale;
  c.height = (shades.length / PAPER_W) * scale;
  c.getContext('2d')!.putImageData(new ImageData(paperRgba(shades, scale), c.width, c.height), 0, 0);
  return new Promise((r) => c.toBlob(r, 'image/png'));
}
