import { useRef, useEffect, useCallback, useState } from 'react';
import { LcdEngine } from '../shaders/lcd-engine';
import { cpuColor, type Filters } from '../shaders/filters';

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
    engine.clear();
    const ro = new ResizeObserver(([e]) => {
      const w = Math.min(2880, Math.round(e.contentRect.width * devicePixelRatio));
      if (w > 0) engine.resize(w, Math.round(w * 0.9));
    });
    if (follow) ro.observe(canvas);
    return () => { ro.disconnect(); engine.destroy(); engineRef.current = null; };
  }, [canvas, follow, webglAvailable]);

  useEffect(() => { engineRef.current?.setFilters(filters, color); }, [filters, color, canvas]);

  const renderFrame = useCallback((framebuffer: Uint8ClampedArray) => {
    if (framebuffer.length < 160 * 144 * 4) return; // a detached WASM view: skip the frame rather than upload garbage
    if (engineRef.current) { engineRef.current.renderFrame(framebuffer); return; }
    const c = canvasEl.current;
    if (webglAvailable || !c) return;
    if (c.width !== 160) { c.width = 160; c.height = 144; }
    const { filters: f, color: col } = look.current;
    c.getContext('2d')?.putImageData(new ImageData(cpuColor(framebuffer, f, col) as Uint8ClampedArray<ArrayBuffer>, 160, 144), 0, 0);
  }, [webglAvailable]);

  /** `canvas` is set once the engine exists: a caller drawing a still frame redraws when it changes. */
  return { canvasRef: setCanvas, canvasKey: webglAvailable ? 'gl' : '2d', renderFrame, webglAvailable, canvas };
}
