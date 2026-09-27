import { useEffect, useSyncExternalStore } from 'react';
import { useLcdShader } from '../../hooks/useLcdShader';
import { useDisplay, useSettingsStore } from '../../store/settingsStore';
import { supportsWebGL2 } from '../../shaders/lcd-engine';
import { neuralStatus } from '../../neural/governor';
import { PALETTES, presetOf, presetsFor, type Correction, type Filters, type ScreenKind, type Upscale } from '../../shaders/filters';
import { Row, Seg, Slider, SwitchRow } from './parts';
import { useT } from '../../i18n';

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
  const t = useT();
  return (
    <div className="notice ai">
      <span className="ic">{t('settings.screen.ai')}</span>
      <span>
        {t('settings.screen.neural')}
        {!supportsWebGL2() ? <> <b>{t('settings.screen.noWebgl')}</b></>
          : level === 1 ? <> <b>{t('settings.screen.slowTable')}</b></>
          : level === 0 ? <> <b>{t('settings.screen.slowNearest')}</b></> : null}
      </span>
    </div>
  );
}

/** Smooth motion: a player-wide switch (not part of a preset or a game’s own settings). */
export function MotionRows() {
  const { smoothMotion, smoothMotionForce, set } = useSettingsStore();
  const t = useT();
  return (
    <>
      <SwitchRow label={t('settings.screen.smooth')} on={smoothMotion} set={(v) => set({ smoothMotion: v })}
        sub={t('settings.screen.smoothSub')} />
      {smoothMotion && (
        <SwitchRow label={t('settings.screen.force')} on={smoothMotionForce} set={(v) => set({ smoothMotionForce: v })}
          sub={t('settings.screen.forceSub')} />
      )}
    </>
  );
}
const SHADES = ['lightest', 'light', 'dark', 'darkest'] as const;

/**
 * Presets with live previews, then every filter. Edits the game's own settings when it has them,
 * else the default for its kind (original Game Boy or Color games).
 */
export function ScreenFilters({ kind, gameId, frame }: { kind: ScreenKind; gameId?: string; frame: Uint8ClampedArray | null }) {
  const { cfg, custom, perGame, choose, tweak, reset, setPerGame } = useDisplay(kind, gameId);
  const f = cfg.filters, color = kind === 'cgb';
  const base = presetOf(cfg.preset)!;
  const t = useT();
  const baseLabel = t(`settings.screen.presets.${base.name}.label`);
  return (
    <div className="filters">
      <div className="presets presets-4">
        {presetsFor(kind).map((p) => (
          <button key={p.name} className="preset" aria-pressed={!custom && cfg.preset === p.name} onClick={() => choose(p.name)}>
            <PresetPreview filters={p.filters} color={color} frame={frame} /><b>{t(`settings.screen.presets.${p.name}.label`)}</b><small>{t(`settings.screen.presets.${p.name}.description`)}</small>
          </button>
        ))}
        {custom && (
          // Not a button: the current selection, never a reset (that is "Reset to …" below).
          <div className="preset" aria-current="true">
            <PresetPreview filters={f} color={color} frame={frame} /><b>{t('settings.screen.custom')}</b><small>{t('settings.screen.basedOn', { name: baseLabel })}</small>
          </div>
        )}
      </div>
      {gameId !== undefined && (
        <SwitchRow label={t('settings.screen.perGame')} sub={perGame ? t('settings.screen.perGameOn') : t('settings.screen.perGameOff')} on={perGame} set={setPerGame} />
      )}

      <div className="filters-h">
        <h3>{t('settings.screen.filters')}</h3>
        <button className="sbtn" disabled={!custom} onClick={reset}>{t('settings.screen.resetTo', { name: baseLabel })}</button>
      </div>
      {color ? (
        <Row label={t('settings.screen.correction')} sub={t('settings.screen.correctionSub')}>
          <Seg<Correction> label={t('settings.screen.correction')} value={f.correction} options={[['off', t('settings.screen.off')], ['accurate', t('settings.screen.accurate')], ['vivid', t('settings.screen.vivid')]]} set={(correction) => tweak({ correction })} />
        </Row>
      ) : (
        <div className="row col">
          <span>{t('settings.screen.palette')}<small>{t('settings.screen.paletteSub')}</small></span>
          <div className="swatches" role="group" aria-label={t('settings.screen.palette')}>
            {[...PALETTES, { id: 'custom' as const, label: 'Custom', colors: f.custom }].map((p) => (
              <button key={p.id} className="swatch" aria-pressed={f.palette === p.id} onClick={() => tweak({ palette: p.id })}>
                <span>{p.colors.map((c, i) => <i key={i} style={{ background: c }} />)}</span>{t(`settings.screen.palettes.${p.id}`)}
              </button>
            ))}
          </div>
          {f.palette === 'custom' && (
            <div className="inks">
              {f.custom.map((c, i) => (
                <label key={i}>
                  <input type="color" value={c} onChange={(e) => tweak({ palette: 'custom', custom: f.custom.map((x, j) => (j === i ? e.target.value : x)) })} />
                  {t(`settings.screen.shades.${SHADES[i]}`)}
                </label>
              ))}
            </div>
          )}
        </div>
      )}
      <Slider label={t('settings.screen.ghosting')} sub={t('settings.screen.ghostingSub')} value={pct(f.ghosting)} min={0} max={70} set={(v) => tweak({ ghosting: v / 100 })} />
      <div className="row col">
        <span>{t('settings.screen.upscaling')}<small>{t('settings.screen.upscalingSub')}</small></span>
        <Seg<Upscale> label={t('settings.screen.upscaling')} value={f.upscale} options={[['nearest', t('settings.screen.nearest')], ['scale2x', 'Scale2x'], ['scale3x', 'Scale3x'], ['smooth', t('settings.screen.smoothUp')], ['neural', 'Neural 4×']]} set={(upscale) => tweak({ upscale })} wrap />
        {f.upscale === 'neural' && <NeuralNote />}
      </div>
      <Slider label={t('settings.screen.grid')} sub={t('settings.screen.gridSub')} value={pct(f.grid)} min={0} max={100} set={(v) => tweak({ grid: v / 100 })} />
      <Slider label={t('settings.screen.scanlines')} value={pct(f.scanlines)} min={0} max={100} set={(v) => tweak({ scanlines: v / 100 })} />
      <SwitchRow label={t('settings.screen.crt')} sub={t('settings.screen.crtSub')} on={f.crt} set={(crt) => tweak({ crt })} />
      <Slider label={t('settings.screen.brightness')} value={pct(f.brightness)} min={-50} max={50} set={(v) => tweak({ brightness: v / 100 })} />
      <Slider label={t('settings.screen.contrast')} value={pct(f.contrast)} min={-50} max={50} set={(v) => tweak({ contrast: v / 100 })} />
      <Slider label={t('settings.screen.saturation')} value={pct(f.saturation)} min={-50} max={50} set={(v) => tweak({ saturation: v / 100 })} />
    </div>
  );
}
