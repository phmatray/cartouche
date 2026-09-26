import { Link } from 'react-router';
import { useSettingsStore, type ScreenSize } from '../../store/settingsStore';
import { PRESETS } from '../../shaders/presets';
import { PresetPreview } from '../player/Manual';
import { Row, Seg, SwitchRow } from './parts';

/** A test card (four grey bands over a checkerboard) so each preset shows how it maps the four shades. */
const PATTERN = (() => {
  const px = new Uint8ClampedArray(160 * 144 * 4);
  const shades = [255, 170, 85, 0];
  for (let y = 0; y < 144; y++) for (let x = 0; x < 160; x++) {
    const v = y < 96 ? shades[Math.floor(x / 40)] : ((x >> 3) + (y >> 3)) % 2 ? 255 : 0;
    px.set([v, v, v, 255], (y * 160 + x) * 4);
  }
  return px;
})();

export function DisplayTab() {
  const { shaderPreset, setShaderPreset, pixelGrid, setPixelGrid, screenSize, setScreenSize } = useSettingsStore();
  return (
    <>
      <h2>Display</h2>
      <p className="intro">The screen style every original Game Boy game starts with. You can still switch in a game’s manual. Game Boy Color games always show their own colors.</p>
      <h3>Screen style</h3>
      <div className="presets presets-4">
        {PRESETS.map((p) => (
          <button key={p.name} className="preset" aria-pressed={shaderPreset === p.name} onClick={() => setShaderPreset(p.name)}>
            <PresetPreview name={p.name} frame={PATTERN} /><b>{p.label}</b><small>{p.description}</small>
          </button>
        ))}
      </div>
      <SwitchRow label="Pixel grid" sub="Shows the LCD dot matrix on DMG Classic, Pocket and Light" on={pixelGrid} set={setPixelGrid} />
      <h3>Size</h3>
      <Row label="Default size" sub="Fit fills the stage; fixed sizes stay pixel-perfect">
        <Seg<ScreenSize> label="Default size" value={screenSize} options={[['fit', 'Fit'], ['2', '2×'], ['3', '3×'], ['4', '4×']]} set={setScreenSize} />
      </Row>
      <h3>Box art</h3>
      <p className="intro" style={{ margin: '8px 0 0' }}>Box art is off by default. Turn it on, see its size or delete it in <Link to="/settings/storage" style={{ color: 'var(--ink)' }}>Storage</Link>.</p>
    </>
  );
}
