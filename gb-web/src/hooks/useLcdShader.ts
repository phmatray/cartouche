import { useRef, useEffect, useCallback, useState } from 'react';
import { LcdEngine } from '../shaders/lcd-engine';
import { cpuColor, type Filters } from '../shaders/filters';
import type { FrameTrace } from '../neural/trace';

/**
 * Draws Game Boy frames on a canvas through the filter chain. The WebGL canvas is kept at the size it
 * is shown in device pixels, so pixel-perfect sizes stay pixel-perfect. Without WebGL, a 2D canvas
 * gets the palette / colour correction and adjustments only. `follow: false` keeps the canvas's own
 * backing size (previews). Put `canvasKey` on the canvas: a failed WebGL set-up swaps in a fresh canvas
 * for the 2D fallback, since a canvas holding a WebGL context never gives a 2D one.
 */
export function useLcdShader(filters: Filters, color: boolean, follow = true) {
  const engineRef = useRef<LcdEngine | null>(null);
  const [canvas, setCanvasState] = useState<HTMLCanvasElement | null>(null);
  const canvasEl = useRef<HTMLCanvasElement | null>(null);
  const setCanvas = useCallback((node: HTMLCanvasElement | null) => { canvasEl.current = node; setCanvasState(node); }, []);
  const [webglAvailable, setWebglAvailable] = useState(true);
  const look = useRef({ filters, color });
  const motion = useRef(false);
  /** Bumped when the browser gives back a lost WebGL context: the engine is rebuilt on it. */
  const [restores, setRestores] = useState(0);
  useEffect(() => { look.current = { filters, color }; }, [filters, color]);

  useEffect(() => {
    if (!canvas || !webglAvailable) return;
    const engine = new LcdEngine(canvas);
    if (!engine.init(canvas.width, canvas.height)) {
      engine.destroy();
      // The WebGL context is an external system: its init result can only be known here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setWebglAvailable(false);
      return;
    }
    engineRef.current = engine;
    engine.setFilters(look.current.filters, look.current.color);
    engine.setMotion(motion.current);
    engine.clear();
    const ro = new ResizeObserver(([e]) => {
      const w = Math.min(2880, Math.round(e.contentRect.width * devicePixelRatio));
      if (w > 0) engine.resize(w, Math.round(w * 0.9));
    });
    if (follow) ro.observe(canvas);
    // iOS drops the WebGL context of a backgrounded app (and a GPU process restart does too). Without preventDefault the
    // browser never gives it back and the screen stays black: keep it restorable, then rebuild the engine on it.
    const lost = (e: Event) => { e.preventDefault(); ro.disconnect(); engine.destroy(); if (engineRef.current === engine) engineRef.current = null; };
    const restored = () => setRestores((n) => n + 1);
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('webglcontextrestored', restored);
    return () => {
      // Listeners first: destroy() loses the context on purpose, and that loss must not be taken for the browser's.
      canvas.removeEventListener('webglcontextlost', lost);
      canvas.removeEventListener('webglcontextrestored', restored);
      ro.disconnect(); engine.destroy(); if (engineRef.current === engine) engineRef.current = null;
    };
  }, [canvas, follow, webglAvailable, restores]);

  useEffect(() => { engineRef.current?.setFilters(filters, color); }, [filters, color, canvas]);

  /** `trace` and `tau`: see LcdEngine.renderFrame. */
  const renderFrame = useCallback((framebuffer: Uint8ClampedArray, fresh = false, trace: FrameTrace | null = null, tau = 0) => {
    if (framebuffer.length < 160 * 144 * 4) return; // a detached WASM view: skip the frame rather than upload garbage
    if (engineRef.current) { engineRef.current.renderFrame(framebuffer, fresh, trace, tau); return; }
    const c = canvasEl.current;
    if (webglAvailable || !c) return;
    if (c.width !== 160) { c.width = 160; c.height = 144; }
    const { filters: f, color: col } = look.current;
    c.getContext('2d')?.putImageData(new ImageData(cpuColor(framebuffer, f, col) as Uint8ClampedArray<ArrayBuffer>, 160, 144), 0, 0);
  }, [webglAvailable]);

  /** Smooth motion: on or off, and the in-between picture for a display refresh without a new frame. */
  const setMotion = useCallback((on: boolean) => { motion.current = on; engineRef.current?.setMotion(on); }, []);
  const drawMotion = useCallback((tau: number) => engineRef.current?.drawMotion(tau), []);
  /** Whether the engine needs the layer trace right now (see LcdEngine.usesTrace). */
  const usesTrace = useCallback(() => engineRef.current?.usesTrace() ?? false, []);

  /** `canvas` is set once the engine exists and `restores` counts rebuilt contexts: a caller drawing a still frame redraws when either changes. */
  return { canvasRef: setCanvas, canvasKey: webglAvailable ? 'gl' : '2d', renderFrame, setMotion, drawMotion, usesTrace, webglAvailable, canvas, restores };
}
