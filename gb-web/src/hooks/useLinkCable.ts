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
  loadRom: (player: LinkPlayer, data: Uint8Array) => void;
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
export function useLinkCable(): LinkCableControls {
  const workerRef = useRef<Worker | null>(null);
  const p1CanvasRef = useRef<HTMLCanvasElement | null>(null);
  const p2CanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number>(0);
  const isRunningRef = useRef(false);
  const waitingFrame = useRef(false);

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
    worker.onmessage = (e: MessageEvent<FromLinkWorkerMsg>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'ready':
          setState(s => ({ ...s, p1Ready: true, p2Ready: true }));
          break;
        case 'romLoaded':
          if (!msg.success) {
            setState(s => ({ ...s, error: `P${msg.player} ROM error: ${msg.error}` }));
          } else {
            setState(s => msg.player === 1
              ? { ...s, p1RomLoaded: true, error: null }
              : { ...s, p2RomLoaded: true, error: null });
          }
          break;
        case 'frame':
          renderToCanvas(p1CanvasRef.current, msg.framebuffers[0]);
          renderToCanvas(p2CanvasRef.current, msg.framebuffers[1]);
          waitingFrame.current = false;
          break;
        case 'error':
          waitingFrame.current = false;
          setState(s => ({ ...s, error: msg.message }));
          break;
      }
    };

    return () => {
      cancelAnimationFrame(rafRef.current);
      worker.terminate();
      workerRef.current = null;
    };
  }, [renderToCanvas]);

  const loadRom = useCallback((player: LinkPlayer, data: Uint8Array) => {
    // Transfer a copy so the original stays intact
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    send({ type: 'loadRom', player, data: buf }, [buf]);
  }, [send]);

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

  return { state, loadRom, start, stop, setInput, p1CanvasRef, p2CanvasRef };
}
