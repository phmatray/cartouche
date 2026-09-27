import { t } from '../i18n';
import { useRef, useState, useCallback, useEffect } from 'react';
import type { FromLinkWorkerMsg, ToLinkWorkerMsg } from '../workers/link-worker';

export type LinkPlayer = 1 | 2;

export interface LinkCableState {
  p1Ready: boolean;
  p2Ready: boolean;
  p1RomLoaded: boolean;
  p2RomLoaded: boolean;
  isRunning: boolean;
  error: string | null;
}

export interface LinkCableControls {
  state: LinkCableState;
  /** Start a player from its battery save (sram) or from a save state instead. */
  loadRom: (player: LinkPlayer, data: Uint8Array, from?: { sram?: Uint8Array; state?: Uint8Array }) => void;
  /** Ask both consoles for their battery saves; they arrive in the `onSram` callback. */
  flush: () => void;
  /** Hand `onSram` the latest battery saves already received, right now (leaving the page: no time to ask the worker). */
  flushNow: () => void;
  start: () => void;
  stop: () => void;
  setInput: (player: LinkPlayer, buttons: number) => void;
  p1CanvasRef: React.RefObject<HTMLCanvasElement | null>;
  p2CanvasRef: React.RefObject<HTMLCanvasElement | null>;
}

/**
 * Both consoles run in one worker so the core can step them in lockstep and carry serial
 * bytes over the cable (Emulator.run_frame_linked).
 */
export function useLinkCable(onSram?: (saves: [Uint8Array | null, Uint8Array | null]) => void): LinkCableControls {
  const onSramRef = useRef(onSram);
  useEffect(() => { onSramRef.current = onSram; }, [onSram]);
  const workerRef = useRef<Worker | null>(null);
  const p1CanvasRef = useRef<HTMLCanvasElement | null>(null);
  const p2CanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number>(0);
  const isRunningRef = useRef(false);
  const waitingFrame = useRef(false);
  const latest = useRef<[Uint8Array | null, Uint8Array | null] | null>(null); // the running session's last battery saves
  const toSaves = (d: [ArrayBuffer | null, ArrayBuffer | null]) => d.map((b) => (b ? new Uint8Array(b) : null)) as [Uint8Array | null, Uint8Array | null];

  const [state, setState] = useState<LinkCableState>({
    p1Ready: false,
    p2Ready: false,
    p1RomLoaded: false,
    p2RomLoaded: false,
    isRunning: false,
    error: null,
  });

  const renderToCanvas = useCallback((canvas: HTMLCanvasElement | null, framebuffer: ArrayBuffer | null) => {
    if (!canvas || !framebuffer) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(framebuffer), 160, 144), 0, 0);
  }, []);

  const send = useCallback((msg: ToLinkWorkerMsg, transfer: Transferable[] = []) => {
    workerRef.current?.postMessage(msg, transfer);
  }, []);

  useEffect(() => {
    const worker = new Worker(new URL('../workers/link-worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    let closing = false; // leaving the page: the battery saves are written first, then the worker ends
    worker.onmessage = (e: MessageEvent<FromLinkWorkerMsg>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'ready':
          setState(s => ({ ...s, p1Ready: true, p2Ready: true }));
          break;
        case 'romLoaded':
          if (!msg.success) {
            setState(s => ({ ...s, error: t('link.romError', { p: String(msg.player), error: String(msg.error) }) }));
          } else {
            setState(s => msg.player === 1
              ? { ...s, p1RomLoaded: true, error: null }
              : { ...s, p2RomLoaded: true, error: null });
          }
          break;
        case 'frame':
          renderToCanvas(p1CanvasRef.current, msg.framebuffers[0]);
          renderToCanvas(p2CanvasRef.current, msg.framebuffers[1]);
          if (msg.sram) latest.current = toSaves(msg.sram);
          waitingFrame.current = false;
          break;
        case 'sram':
          latest.current = toSaves(msg.data);
          onSramRef.current?.(latest.current);
          if (closing) worker.terminate();
          break;
        case 'error':
          waitingFrame.current = false;
          setState(s => ({ ...s, error: msg.message }));
          break;
      }
    };

    return () => {
      cancelAnimationFrame(rafRef.current);
      isRunningRef.current = false;
      closing = true;
      // Unloading, the worker's reply never arrives: write what is already here, then ask for fresher saves anyway.
      if (latest.current) onSramRef.current?.(latest.current);
      worker.postMessage({ type: 'exportSram' } satisfies ToLinkWorkerMsg);
      setTimeout(() => worker.terminate(), 3000);
      workerRef.current = null;
    };
  }, [renderToCanvas]);

  const loadRom = useCallback((player: LinkPlayer, data: Uint8Array, from: { sram?: Uint8Array; state?: Uint8Array } = {}) => {
    // Transfer copies so the originals stay intact
    const copy = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
    latest.current = null; // a new session: never write the previous one's saves to its targets
    const buf = copy(data), sram = from.sram && copy(from.sram), state = from.state && copy(from.state);
    send({ type: 'loadRom', player, data: buf, sram, state }, [buf, sram, state].filter((b): b is ArrayBuffer => !!b));
  }, [send]);
  const flush = useCallback(() => send({ type: 'exportSram' }), [send]);
  const flushNow = useCallback(() => { if (latest.current) onSramRef.current?.(latest.current); }, []);

  const frameLoop = useCallback(function loop() {
    if (!isRunningRef.current) return;
    if (!waitingFrame.current) {
      waitingFrame.current = true;
      send({ type: 'runFrame' });
    }
    rafRef.current = requestAnimationFrame(loop);
  }, [send]);

  const start = useCallback(() => {
    isRunningRef.current = true;
    setState(s => ({ ...s, isRunning: true }));
    waitingFrame.current = false;
    rafRef.current = requestAnimationFrame(frameLoop);
  }, [frameLoop]);

  const stop = useCallback(() => {
    isRunningRef.current = false;
    setState(s => ({ ...s, isRunning: false }));
    cancelAnimationFrame(rafRef.current);
  }, []);

  const setInput = useCallback((player: LinkPlayer, buttons: number) => {
    send({ type: 'setInput', player, buttons });
  }, [send]);

  return { state, loadRom, flush, flushNow, start, stop, setInput, p1CanvasRef, p2CanvasRef };
}
