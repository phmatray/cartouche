import { useRef, useEffect, useCallback, useState } from 'react';
import { LcdEngine, type PresetName } from '../shaders/lcd-engine';
import { PRESETS } from '../shaders/presets';
import { useSettingsStore } from '../store/settingsStore';

/** WebGL LCD renderer for a canvas. Preset (unless overridden) and pixel grid follow the settings store. */
export function useLcdShader(scale: number, presetOverride?: PresetName) {
  const engineRef = useRef<LcdEngine | null>(null);
  const [canvas, setCanvasState] = useState<HTMLCanvasElement | null>(null);
  const canvasEl = useRef<HTMLCanvasElement | null>(null);
  const setCanvas = useCallback((node: HTMLCanvasElement | null) => { canvasEl.current = node; setCanvasState(node); }, []);
  const [webglAvailable, setWebglAvailable] = useState(true);
  const storedPreset = useSettingsStore((s) => s.shaderPreset);
  const preset = presetOverride ?? storedPreset;
  const grid = useSettingsStore((s) => s.pixelGrid);

  useEffect(() => {
    if (!canvas) return;
    const engine = new LcdEngine(canvas);
    if (!engine.init(160 * scale, 144 * scale)) {
      // The WebGL context is an external system: its init result can only be known here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setWebglAvailable(false);
      return;
    }
    engineRef.current = engine;
    engine.clear();
    return () => { engine.destroy(); engineRef.current = null; };
  }, [scale, canvas]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setPreset((PRESETS.find((p) => p.name === preset) ?? PRESETS[0]).source);
    engine.grid = grid ? 1 : 0;
  }, [preset, grid, canvas, webglAvailable]);

  const renderFrame = useCallback((framebuffer: Uint8ClampedArray) => {
    if (framebuffer.length < 160 * 144 * 4) return; // a detached WASM view: skip the frame rather than upload garbage
    if (engineRef.current) { engineRef.current.renderFrame(framebuffer); return; }
    const c = canvasEl.current;
    if (webglAvailable || !c) return;
    // No WebGL: raw pixels on a 2D context, scaled up by CSS.
    if (c.width !== 160) { c.width = 160; c.height = 144; }
    c.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(framebuffer), 160, 144), 0, 0);
  }, [webglAvailable]);

  return { canvasRef: setCanvas, renderFrame, webglAvailable };
}
