import { useEffect, useSyncExternalStore } from 'react';
import { useLcdShader } from '../../hooks/useLcdShader';
import { useDisplay, useSettingsStore } from '../../store/settingsStore';
import { supportsWebGL2 } from '../../shaders/lcd-engine';
import { neuralStatus } from '../../neural/governor';
import { PALETTES, presetOf, presetsFor, type Correction, type Filters, type ScreenKind, type Upscale } from '../../shaders/filters';
import { Row, Seg, Slider, SwitchRow } from './parts';

/** A frame drawn through the actual filter chain, on its own small canvas. */
export function PresetPreview({ filters, color, frame }: { filters: Filters; color: boolean; frame: Uint8ClampedArray | null }) {
  // A fixed 4x backing size, not the shown size: at ~1 device pixel per Game Boy pixel the grid and
  // scanlines would fade out and every card would differ only by its colours.
  const { canvasRef, canvasKey, renderFrame, canvas } = useLcdShader(filters, color, false);
  useEffect(() => { if (frame) renderFrame(frame); }, [frame, renderFrame, filters, color, canvas]);
  return <canvas key={canvasKey} ref={canvasRef} className="lcd" width={640} height={576} aria-hidden="true" />;
}

const pct = (v: number) => Math.round(v * 100);

/** The AI disclosure shown wherever Neural 4× is on. */
export function NeuralNote() {
  const level = useSyncExternalStore(neuralStatus.subscribe, neuralStatus.get);
  return (
    <div className="notice ai">
      <span className="ic">AI</span>
      <span>
        Upscaled by a neural network trained on Game Boy frames; it adds detail that wasn’t in the original pixels.
        Previews and paused frames use its fast table until the game runs.
        {!supportsWebGL2() ? <> <b>This browser has no WebGL 2, so it shows Nearest.</b></>
          : level === 1 ? <> <b>Too slow on this device: running as the fast table only.</b></>
          : level === 0 ? <> <b>Too slow on this device: showing Nearest for now.</b></> : null}
      </span>
    </div>
  );
}

/** Smooth motion: a player-wide switch (not part of a preset or a game’s own settings). */
export function MotionRows() {
  const { smoothMotion, smoothMotionForce, set } = useSettingsStore();
  return (
    <>
      <SwitchRow label="Smooth motion (120 Hz)" on={smoothMotion} set={(v) => set({ smoothMotion: v })}
        sub="In-between frames from the game’s exact scroll and sprite positions, on screens over 60 Hz. About 8 ms more delay; Neural 4× pauses while it runs." />
      {smoothMotion && (
        <SwitchRow label="Also on 60 Hz screens" on={smoothMotionForce} set={(v) => set({ smoothMotionForce: v })}
          sub="Off by default: a 60 Hz screen has no room for extra frames, it only adds delay" />
      )}
    </>
  );
}
const SHADES = ['Lightest', 'Light', 'Dark', 'Darkest'];

/**
 * Presets with live previews, then every filter. Edits the game's own settings when it has them,
 * else the default for its kind (original Game Boy or Color games).
 */
export function ScreenFilters({ kind, gameId, frame }: { kind: ScreenKind; gameId?: string; frame: Uint8ClampedArray | null }) {
  const { cfg, custom, perGame, choose, tweak, reset, setPerGame } = useDisplay(kind, gameId);
  const f = cfg.filters, color = kind === 'cgb';
  const base = presetOf(cfg.preset)!;
  return (
    <div className="filters">
      <div className="presets presets-4">
        {presetsFor(kind).map((p) => (
          <button key={p.name} className="preset" aria-pressed={!custom && cfg.preset === p.name} onClick={() => choose(p.name)}>
            <PresetPreview filters={p.filters} color={color} frame={frame} /><b>{p.label}</b><small>{p.description}</small>
          </button>
        ))}
        {custom && (
          // Not a button: the current selection, never a reset (that is "Reset to …" below).
          <div className="preset" aria-current="true">
            <PresetPreview filters={f} color={color} frame={frame} /><b>Custom</b><small>Based on {base.label}</small>
          </div>
        )}
      </div>
      {gameId !== undefined && (
        <SwitchRow label="Use these settings for this game only" sub={perGame ? 'Other games keep your default' : 'Changes apply to every game of this kind'} on={perGame} set={setPerGame} />
      )}

      <div className="filters-h">
        <h3>Filters</h3>
        <button className="sbtn" disabled={!custom} onClick={reset}>Reset to {base.label}</button>
      </div>
      {color ? (
        <Row label="Color correction" sub="How a real Game Boy Color LCD shows the colors">
          <Seg<Correction> label="Color correction" value={f.correction} options={[['off', 'Off'], ['accurate', 'Accurate'], ['vivid', 'Vivid']]} set={(correction) => tweak({ correction })} />
        </Row>
      ) : (
        <div className="row col">
          <span>Palette<small>The four shades of an original Game Boy screen</small></span>
          <div className="swatches" role="group" aria-label="Palette">
            {[...PALETTES, { id: 'custom' as const, label: 'Custom', colors: f.custom }].map((p) => (
              <button key={p.id} className="swatch" aria-pressed={f.palette === p.id} onClick={() => tweak({ palette: p.id })}>
                <span>{p.colors.map((c, i) => <i key={i} style={{ background: c }} />)}</span>{p.label}
              </button>
            ))}
          </div>
          {f.palette === 'custom' && (
            <div className="inks">
              {f.custom.map((c, i) => (
                <label key={i}>
                  <input type="color" value={c} onChange={(e) => tweak({ palette: 'custom', custom: f.custom.map((x, j) => (j === i ? e.target.value : x)) })} />
                  {SHADES[i]}
                </label>
              ))}
            </div>
          )}
        </div>
      )}
      <Slider label="Ghosting" sub="LCD persistence: moving sprites leave a trail, flicker blends" value={pct(f.ghosting)} min={0} max={70} set={(v) => tweak({ ghosting: v / 100 })} />
      <div className="row col">
        <span>Upscaling<small>Nearest and Smooth keep square pixels; Scale2x, 3x and Neural 4× round off pixel-art edges</small></span>
        <Seg<Upscale> label="Upscaling" value={f.upscale} options={[['nearest', 'Nearest'], ['scale2x', 'Scale2x'], ['scale3x', 'Scale3x'], ['smooth', 'Smooth'], ['neural', 'Neural 4×']]} set={(upscale) => tweak({ upscale })} wrap />
        {f.upscale === 'neural' && <NeuralNote />}
      </div>
      <Slider label="Pixel grid" sub="The LCD’s dot matrix" value={pct(f.grid)} min={0} max={100} set={(v) => tweak({ grid: v / 100 })} />
      <Slider label="Scanlines" value={pct(f.scanlines)} min={0} max={100} set={(v) => tweak({ scanlines: v / 100 })} />
      <SwitchRow label="CRT curvature" sub="A curved TV tube with darker corners" on={f.crt} set={(crt) => tweak({ crt })} />
      <Slider label="Brightness" value={pct(f.brightness)} min={-50} max={50} set={(v) => tweak({ brightness: v / 100 })} />
      <Slider label="Contrast" value={pct(f.contrast)} min={-50} max={50} set={(v) => tweak({ contrast: v / 100 })} />
      <Slider label="Saturation" value={pct(f.saturation)} min={-50} max={50} set={(v) => tweak({ saturation: v / 100 })} />
    </div>
  );
}
